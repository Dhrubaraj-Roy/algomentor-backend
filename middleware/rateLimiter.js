const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const redisClient = require("../config/redis");

const INCREMENT_LUA_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

const DECREMENT_LUA_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if not current then
  return 0
end
if tonumber(current) <= 1 then
  redis.call("DEL", KEYS[1])
  return 0
end
return redis.call("DECR", KEYS[1])
`;

/**
 * Shared Redis-backed store implementing the express-rate-limit v8 Store interface.
 * Ensures rate-limit counters are shared across horizontally scaled Node.js instances.
 */
class RedisRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.localKeys = false;
    this.windowMs = 60 * 1000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  #getKey(key) {
    return `${this.prefix}${key}`;
  }

  #ensureReady() {
    if (!redisClient.isReady) {
      throw new Error("Redis client is not ready for rate limiting.");
    }
  }

  async get(key) {
    this.#ensureReady();
    const redisKey = this.#getKey(key);
    const [hits, ttlMs] = await Promise.all([
      redisClient.get(redisKey),
      redisClient.pTTL(redisKey),
    ]);

    if (hits === null) {
      return undefined;
    }

    const totalHits = Number(hits);
    const resetTime = ttlMs > 0 ? new Date(Date.now() + ttlMs) : undefined;
    return { totalHits, resetTime };
  }

  async increment(key) {
    this.#ensureReady();
    const redisKey = this.#getKey(key);
    const [totalHits, ttlMs] = await redisClient.eval(INCREMENT_LUA_SCRIPT, {
      keys: [redisKey],
      arguments: [String(this.windowMs)],
    });

    const parsedTtl = Number(ttlMs);
    return {
      totalHits: Number(totalHits),
      resetTime: new Date(
        Date.now() + (parsedTtl > 0 ? parsedTtl : this.windowMs)
      ),
    };
  }

  async decrement(key) {
    if (!redisClient.isReady) return;
    await redisClient.eval(DECREMENT_LUA_SCRIPT, {
      keys: [this.#getKey(key)],
      arguments: [],
    });
  }

  async resetKey(key) {
    if (!redisClient.isReady) return;
    await redisClient.del(this.#getKey(key));
  }
}

/**
 * Factory for creating rate limiters backed by a dedicated Redis prefix
 * with consistent 429 JSON responses and fail-open behavior on Redis outages.
 */
function createRateLimiter({
  prefix,
  windowMs,
  max,
  message,
  keyGenerator,
  skipSuccessfulRequests = false,
}) {
  const defaultRetrySeconds = Math.ceil(windowMs / 1000);

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // Returns standard `RateLimit-*` headers
    legacyHeaders: false, // Disables legacy `X-RateLimit-*` headers
    passOnStoreError: true, // Fail open if Redis is temporarily unavailable
    skipSuccessfulRequests,
    store: new RedisRateLimitStore(prefix),
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (req, res) => {
      const resetMs = req.rateLimit?.resetTime?.getTime();
      const retryAfter =
        resetMs && resetMs > Date.now()
          ? Math.ceil((resetMs - Date.now()) / 1000)
          : defaultRetrySeconds;

      return res.status(429).json({
        status: 429,
        message,
        retryAfter,
      });
    },
  });
}

const userKeyGenerator = (req) =>
  req.user?._id ? req.user._id.toString() : ipKeyGenerator(req.ip);

const accountEmailKeyGenerator = (req) => {
  const rawEmail = req.body?.emailId || req.body?.email;
  if (typeof rawEmail === "string" && rawEmail.trim().length > 0) {
    return `email:${rawEmail.trim().toLowerCase()}`;
  }
  return ipKeyGenerator(req.ip);
};

/**
 * AI Chat Rate Limiter
 * Limits requests to 5 per minute per authenticated user (fallback to IP).
 * Prevents credit exhaustion, token spam, and bot abuse on expensive Groq AI models.
 */
const chatRateLimiter = createRateLimiter({
  prefix: "rl:chat:",
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: userKeyGenerator,
  message:
    "You have exceeded the AI chat rate limit (5 requests per minute). Please take a breath and try again shortly.",
});

/**
 * Registration Rate Limiter
 * Limits registration attempts to 20 per 15 minutes per IP to accommodate
 * legitimate onboarding spikes on shared networks while blocking mass signups.
 */
const authRateLimiter = createRateLimiter({
  prefix: "rl:auth:",
  windowMs: 15 * 60 * 1000,
  max: 20,
  message:
    "Too many registration attempts from this IP address. Please try again after 15 minutes.",
});

/**
 * Login IP Rate Limiter (Layer 1)
 * Limits failed login attempts to 25 per 15 minutes per IP.
 * Successful logins are skipped so legitimate users sharing a NAT/Wi-Fi IP
 * do not lock each other out under high traffic.
 */
const loginIpRateLimiter = createRateLimiter({
  prefix: "rl:login-ip:",
  windowMs: 15 * 60 * 1000,
  max: 25,
  skipSuccessfulRequests: true,
  message:
    "Too many failed login attempts from this IP address. Please try again after 15 minutes.",
});

/**
 * Login Account Rate Limiter (Layer 2)
 * Limits failed login attempts to 5 per 15 minutes per email address (across all IPs).
 * Defends individual accounts against distributed / rotating-IP brute-force attacks.
 */
const loginAccountRateLimiter = createRateLimiter({
  prefix: "rl:login-acct:",
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  keyGenerator: accountEmailKeyGenerator,
  message:
    "Too many failed login attempts for this account. Please try again after 15 minutes.",
});

/**
 * Code Submission Rate Limiter
 * Limits code runs/submissions to 15 per minute per authenticated user.
 * Protects Judge0 queue and BullMQ workers from infinite loop flood attacks.
 */
const submissionRateLimiter = createRateLimiter({
  prefix: "rl:submission:",
  windowMs: 60 * 1000,
  max: 15,
  keyGenerator: userKeyGenerator,
  message:
    "Too many code submissions in a short period. Please wait a moment before submitting again.",
});

module.exports = {
  chatRateLimiter,
  authRateLimiter,
  loginIpRateLimiter,
  loginAccountRateLimiter,
  submissionRateLimiter,
  RedisRateLimitStore,
};

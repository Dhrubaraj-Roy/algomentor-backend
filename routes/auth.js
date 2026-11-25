const express = require("express");
const authRouter = express.Router();
const {
  register,
  login,
  logout,
  adminRegister,
  deleteProfile,
  checkAuth,
} = require("../controllers/userAuth");
const userAuth = require("../middleware/userAuth");
const adminAuth = require("../middleware/adminAuth");
const {
  authRateLimiter,
  loginIpRateLimiter,
  loginAccountRateLimiter,
} = require("../middleware/rateLimiter");

// Check Auth (gracefully returns auth status: true/false without throwing 401)
authRouter.get("/check", checkAuth);

// Register (role is always user - rate-limited to 20 per 15 mins per IP)
authRouter.post("/register", authRateLimiter, register);

// Login (layered IP + per-account failed-attempt rate limiters)
authRouter.post("/login", loginIpRateLimiter, loginAccountRateLimiter, login);

// Logout (protected with userAuth middleware)
authRouter.post("/logout", userAuth, logout);

// Admin Register (only an authenticated admin can access this)
authRouter.post("/admin/register", userAuth, adminAuth, adminRegister);

// Profile (protected route to verify userAuth middleware)
authRouter.get("/profile", userAuth, async (req, res) => {
  res.status(200).json({ user: req.user });
});

// Delete My Profile (User deletes their own account)
authRouter.delete("/profile", userAuth, deleteProfile);

module.exports = authRouter;

import { Router } from "express";
import { requireAuth } from "./auth.middleware.js";
import {
  changePasswordUser,
  currentUser,
  forgotPasswordUser,
  resetPasswordUser,
  googleLoginUser,
  loginUser,
  logoutUser,
  registerUser,
} from "./auth.controller.js";

export const authRouter = Router();

authRouter.post("/register", registerUser);
authRouter.post("/login", loginUser);
authRouter.post("/google", googleLoginUser);
authRouter.post("/forgot-password", forgotPasswordUser);
authRouter.post("/reset-password", resetPasswordUser);
authRouter.patch("/password", requireAuth, changePasswordUser);
authRouter.post("/logout", logoutUser);
authRouter.get("/me", currentUser);

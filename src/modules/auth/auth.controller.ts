import type { Request, Response } from "express";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  googleSchema,
  loginSchema,
  registerSchema,
} from "./auth.schemas.js";
import { z } from "zod";
import {
  forgotPassword,
  changePassword,
  getUserFromSession,
  login,
  loginWithGoogle,
  logout,
  register,
  resetPassword,
  SESSION_COOKIE,
} from "./auth.service.js";

const cookieOptions = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === "production" ? ("none" as const) : ("lax" as const),
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export async function registerUser(req: Request, res: Response) {
  const result = await register(registerSchema.parse(req.body));
  setSessionCookie(res, result.sessionId, result.expiresAt);
  res.status(201).json({ success: true, data: { user: result.user } });
}
export async function loginUser(req: Request, res: Response) {
  const result = await login(loginSchema.parse(req.body));
  setSessionCookie(res, result.sessionId, result.expiresAt);
  res.json({ success: true, data: { user: result.user } });
}
export async function googleLoginUser(req: Request, res: Response) {
  const result = await loginWithGoogle(googleSchema.parse(req.body));
  setSessionCookie(res, result.sessionId, result.expiresAt);
  res.json({ success: true, data: { user: result.user } });
}
export async function forgotPasswordUser(req: Request, res: Response) {
  const result = await forgotPassword(forgotPasswordSchema.parse(req.body));
  res.json({ success: true, data: result });
}
export async function changePasswordUser(req: Request, res: Response) {
  const user = res.locals.user as { id: string };
  const result = await changePassword(user.id, changePasswordSchema.parse(req.body));
  res.json({ success: true, data: result });
}
export async function resetPasswordUser(req: Request, res: Response) {
  const body = z
    .object({
      token: z.string().min(32),
      password: z.string().min(6).max(128),
    })
    .parse(req.body);
  const result = await resetPassword(body.token, body.password);
  res.json({ success: true, data: result });
}
export async function currentUser(req: Request, res: Response) {
  const sessionId = req.cookies[SESSION_COOKIE];
  const user = sessionId ? await getUserFromSession(sessionId) : null;
  if (!user) {
    res.status(401).json({
      success: false,
      error: { code: "UNAUTHENTICATED", message: "You are not signed in." },
    });
    return;
  }
  res.json({ success: true, data: { user } });
}
export async function logoutUser(req: Request, res: Response) {
  const sessionId = req.cookies[SESSION_COOKIE];
  if (sessionId) await logout(sessionId);
  res.clearCookie(SESSION_COOKIE, cookieOptions);
  res.json({ success: true, data: { message: "Signed out successfully." } });
}
function setSessionCookie(res: Response, sessionId: string, expiresAt: string) {
  res.cookie(SESSION_COOKIE, sessionId, { ...cookieOptions, expires: new Date(expiresAt) });
}

import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware.js";
import { requireAdmin, requireAdminOrStaff } from "../auth/admin.middleware.js";
import {
  listAdminApplicationsController,
  listAdminUsersController,
  getAdminApplicationController,
  createStaffController,
  listStaffController,
  removeStaffController,
  updateUserPaymentStatusController,
  updateAdminApplicationStatusController,
} from "./admin.controller.js";
import {
  staffDocumentUploadMiddleware,
  deleteStaffDocument,
  uploadStaffDocument,
} from "../staff/staff.routes.js";

export const adminRoutes = Router();

adminRoutes.use(requireAuth, requireAdminOrStaff);
adminRoutes.post("/staff", requireAdmin, createStaffController);
adminRoutes.get("/staff", requireAdmin, listStaffController);
adminRoutes.delete("/staff/:id", requireAdmin, removeStaffController);
adminRoutes.get("/users", listAdminUsersController);
adminRoutes.patch("/users/:id/payment-status", updateUserPaymentStatusController);
adminRoutes.get("/applications", listAdminApplicationsController);
adminRoutes.get("/applications/:id", getAdminApplicationController);
adminRoutes.post(
  "/applications/:applicationId/documents",
  staffDocumentUploadMiddleware.fields([
    { name: "file", maxCount: 1 },
    { name: "document", maxCount: 1 },
  ]),
  uploadStaffDocument,
);
adminRoutes.delete(
  "/applications/:applicationId/documents/:documentId",
  deleteStaffDocument,
);
adminRoutes.patch("/applications/:id/status", requireAdmin, updateAdminApplicationStatusController);

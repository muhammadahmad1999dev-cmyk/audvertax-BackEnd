import { Router } from "express";
import crypto from "node:crypto";
import multer from "multer";
import { requireAuth } from "../auth/auth.middleware.js";
import { requireAdminOrStaff } from "../auth/admin.middleware.js";
import {
  getAdminApplicationController,
  listAdminUsersController,
  listAdminApplicationsController,
  updateAdminApplicationStatusController,
} from "../admin/admin.controller.js";
import { applicationStore } from "../applications/application.store.js";
import { findOrder } from "../billing/billing.store.js";
import { supabase } from "../../config/supabase.js";

const BUCKET = "application-documents";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    callback(null, ["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype));
  },
});

export const staffRoutes = Router();

staffRoutes.use(requireAuth, requireAdminOrStaff);
staffRoutes.get("/users", listAdminUsersController);
staffRoutes.get("/applications", listAdminApplicationsController);
staffRoutes.get("/applications/:applicationId", getAdminApplicationController);
staffRoutes.patch("/applications/:id/status", updateAdminApplicationStatusController);
staffRoutes.post(
  "/applications/:applicationId/documents",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "document", maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const applicationId = Array.isArray(req.params.applicationId)
        ? req.params.applicationId[0]
        : req.params.applicationId;
      const application = await applicationStore.findById(applicationId);
      const billing = application ? await findOrder(application.id, application.userId) : null;
      if (!application || billing?.status !== "paid") {
        res.status(404).json({
          success: false,
          error: { code: "APPLICATION_NOT_FOUND", message: "Paid application not found." },
        });
        return;
      }

      const uploadedFiles = req.files as Record<string, Express.Multer.File[]> | undefined;
      const file = uploadedFiles?.file?.[0] ?? uploadedFiles?.document?.[0];
      if (!file) {
        res.status(400).json({
          success: false,
          error: { code: "DOCUMENT_REQUIRED", message: "A PDF, JPEG, or PNG file is required." },
        });
        return;
      }

      const documentId = "doc_" + crypto.randomUUID();
      const requestedDocumentName =
        typeof req.body.documentName === "string" ? req.body.documentName.trim() : "";
      const documentName = requestedDocumentName || file.originalname;
      const extension = file.originalname.includes(".")
        ? "." + file.originalname.split(".").pop()!.toLowerCase()
        : "";
      const storagePath = `${application.id}/${documentId}${extension}`;
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          cacheControl: "3600",
          upsert: false,
        });
      if (uploadError) throw uploadError;

      const currentUploads = Array.isArray(application.documents.staffUploads)
        ? application.documents.staffUploads
        : [];
      const document = {
        id: documentId,
        name: documentName,
        documentName,
        type: file.mimetype,
        size: file.size,
        path: storagePath,
        uploadedBy: res.locals.user.id,
        uploadedByRole: res.locals.user.role,
        uploadedByName: `${res.locals.user.firstName} ${res.locals.user.lastName}`.trim(),
        uploadedAt: new Date().toISOString(),
      };
      const updated = await applicationStore.update(application.id, {
        documents: { ...application.documents, staffUploads: [...currentUploads, document] },
      });

      res.status(201).json({ success: true, data: { document, application: updated } });
    } catch (error) {
      next(error);
    }
  },
);

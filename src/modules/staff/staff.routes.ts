import { Router, type NextFunction, type Request, type Response } from "express";
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
import { logger } from "../../utils/logger.js";

const BUCKET = "application-documents";
export const staffDocumentUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    callback(null, ["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype));
  },
});

export const staffRoutes = Router();

export async function uploadStaffDocument(req: Request, res: Response, next: NextFunction) {
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
    let updated;
    try {
      updated = await applicationStore.appendStaffDocument(application.id, document);
    } catch (error) {
      try {
        await supabase.storage.from(BUCKET).remove([storagePath]);
      } catch (cleanupError) {
        logger.warn(
          { err: cleanupError },
          "Failed to clean up document storage after metadata write failure",
        );
      }
      throw error;
    }

    if (!updated) {
      await supabase.storage.from(BUCKET).remove([storagePath]);
      res.status(404).json({
        success: false,
        error: { code: "APPLICATION_NOT_FOUND", message: "Paid application not found." },
      });
      return;
    }

    res.status(201).json({ success: true, data: { document, application: updated } });
  } catch (error) {
    next(error);
  }
}

staffRoutes.use(requireAuth, requireAdminOrStaff);
staffRoutes.get("/users", listAdminUsersController);
staffRoutes.get("/applications", listAdminApplicationsController);
staffRoutes.get("/applications/:applicationId", getAdminApplicationController);
staffRoutes.patch("/applications/:id/status", updateAdminApplicationStatusController);
staffRoutes.post(
  "/applications/:applicationId/documents",
  staffDocumentUploadMiddleware.fields([
    { name: "file", maxCount: 1 },
    { name: "document", maxCount: 1 },
  ]),
  uploadStaffDocument,
);

export async function downloadStaffDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const applicationId = Array.isArray(req.params.applicationId)
      ? req.params.applicationId[0]
      : req.params.applicationId;
    const documentId = Array.isArray(req.params.documentId)
      ? req.params.documentId[0]
      : req.params.documentId;
    const application = await applicationStore.findById(applicationId);
    const billing = application ? await findOrder(application.id, application.userId) : null;
    if (!application || (res.locals.user.role === "staff" && billing?.status !== "paid")) {
      res.status(404).json({
        success: false,
        error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." },
      });
      return;
    }

    const findDocument = (value: unknown): Record<string, unknown> | null => {
      if (!value || typeof value !== "object") return null;
      if (Array.isArray(value)) {
        for (const item of value) {
          const document = findDocument(item);
          if (document) return document;
        }
        return null;
      }
      const record = value as Record<string, unknown>;
      if (record.id === documentId) return record;
      for (const child of Object.values(record)) {
        const document = findDocument(child);
        if (document) return document;
      }
      return null;
    };

    const searchableDocuments =
      res.locals.user.role === "admin"
        ? application.documents
        : { staffUploads: application.documents.staffUploads };
    const document = findDocument(searchableDocuments);
    if (!document || typeof document.path !== "string") {
      res.status(404).json({
        success: false,
        error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." },
      });
      return;
    }

    const { data, error } = await supabase.storage.from(BUCKET).download(document.path);
    if (error || !data) {
      res.status(404).json({
        success: false,
        error: { code: "DOCUMENT_NOT_FOUND", message: "Document file not found." },
      });
      return;
    }

    const filename =
      String(document.name ?? document.documentName ?? documentId)
        .replace(/[\r\n"\\/]/g, "_")
        .trim() || documentId;
    res.setHeader("Content-Type", String(document.type ?? "application/octet-stream"));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(await data.arrayBuffer()));
  } catch (error) {
    next(error);
  }
}

staffRoutes.get("/applications/:applicationId/documents/:documentId", downloadStaffDocument);

export async function deleteStaffDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const applicationId = Array.isArray(req.params.applicationId)
      ? req.params.applicationId[0]
      : req.params.applicationId;
    const documentId = Array.isArray(req.params.documentId)
      ? req.params.documentId[0]
      : req.params.documentId;
    const application = await applicationStore.findById(applicationId);
    const billing =
      application && res.locals.user.role === "staff"
        ? await findOrder(application.id, application.userId)
        : null;
    if (!application || (res.locals.user.role === "staff" && billing?.status !== "paid")) {
      res.status(404).json({
        success: false,
        error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." },
      });
      return;
    }

    const result = await applicationStore.deleteDocumentById(
      application.id,
      documentId,
      res.locals.user.role === "staff",
    );
    if (!result.application) {
      res.status(404).json({
        success: false,
        error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." },
      });
      return;
    }

    const document = result.deletedDocument;
    if (!document) {
      res.status(404).json({
        success: false,
        error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." },
      });
      return;
    }

    if (typeof document.path === "string") {
      const documentKey = `${application.id}/${documentId}`;
      const suffix = document.path.startsWith(documentKey)
        ? document.path.slice(documentKey.length)
        : null;
      if (suffix !== null && (suffix === "" || /^\.[a-zA-Z0-9]+$/.test(suffix))) {
        const { error } = await supabase.storage.from(BUCKET).remove([document.path]);
        if (error) throw error;
      }
    }

    res.json({
      success: true,
      data: {
        deletedDocumentId: documentId,
        documents: result.application.documents,
        application: result.application,
      },
    });
  } catch (error) {
    next(error);
  }
}

staffRoutes.delete("/applications/:applicationId/documents/:documentId", deleteStaffDocument);

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Request, Response } from "express";
import { requireAdminOrStaff } from "../auth/admin.middleware.js";
import { applicationStore } from "../applications/application.store.js";
import type { Application } from "../applications/application.types.js";
import { deleteStaffDocument } from "./staff.routes.js";

const originalFindById = applicationStore.findById;
const originalDeleteDocumentById = applicationStore.deleteDocumentById;

function makeApplication(documents: Record<string, unknown>): Application {
  return {
    id: "application-1",
    userId: "customer-1",
    serviceSlug: "uk-corporate-tax",
    status: "paid",
    data: { unrelated: "keep" },
    documents,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function makeResponse(role = "admin") {
  const result = {
    statusCode: 200,
    payload: undefined as unknown,
    locals: { user: { id: "staff-1", role, firstName: "Staff", lastName: "Member" } },
    status(code: number) {
      result.statusCode = code;
      return result;
    },
    json(payload: unknown) {
      result.payload = payload;
      return result;
    },
  };
  return result;
}

function makeRequest(applicationId: string, documentId: string) {
  return { params: { applicationId, documentId } } as unknown as Request;
}

describe("staff document deletion", { concurrency: false }, () => {
  test.afterEach(() => {
    applicationStore.findById = originalFindById;
    applicationStore.deleteDocumentById = originalDeleteDocumentById;
  });

  test("deletes one document and returns all other categories and metadata", async () => {
    const remaining = makeApplication({
      identity: [{ id: "doc-keep", name: "Passport", uploadedBy: "customer-1" }],
      staffUploads: [{ id: "doc-staff", name: "Review", uploadedByRole: "staff" }],
    });
    applicationStore.findById = async () => makeApplication({});
    applicationStore.deleteDocumentById = async (applicationId, documentId, staffOnly) => {
      assert.deepEqual(
        [applicationId, documentId, staffOnly],
        ["application-1", "doc-delete", false],
      );
      return { application: remaining, deletedDocument: { id: "doc-delete" } };
    };

    const res = makeResponse();
    await deleteStaffDocument(
      makeRequest("application-1", "doc-delete"),
      res as unknown as Response,
      () => {},
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
      success: true,
      data: {
        deletedDocumentId: "doc-delete",
        documents: remaining.documents,
        application: remaining,
      },
    });
  });

  test("returns application not found without mutating an unknown application", async () => {
    applicationStore.findById = async () => null;
    applicationStore.deleteDocumentById = async () => {
      assert.fail("unknown applications must not be mutated");
    };

    const res = makeResponse();
    await deleteStaffDocument(
      makeRequest("missing", "doc-1"),
      res as unknown as Response,
      () => {},
    );

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.payload, {
      success: false,
      error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." },
    });
  });

  test("returns document not found for an unknown ID", async () => {
    applicationStore.findById = async () => makeApplication({});
    applicationStore.deleteDocumentById = async () => ({
      application: makeApplication({}),
      deletedDocument: null,
    });

    const res = makeResponse();
    await deleteStaffDocument(
      makeRequest("application-1", "missing"),
      res as unknown as Response,
      () => {},
    );

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.payload, {
      success: false,
      error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." },
    });
  });

  test("scopes document lookup to the requested application", async () => {
    applicationStore.findById = async () => ({ ...makeApplication({}), id: "application-2" });
    applicationStore.deleteDocumentById = async (applicationId, documentId) => {
      assert.deepEqual([applicationId, documentId], ["application-2", "doc-from-application-1"]);
      return { application: makeApplication({}), deletedDocument: null };
    };

    const res = makeResponse();
    await deleteStaffDocument(
      makeRequest("application-2", "doc-from-application-1"),
      res as unknown as Response,
      () => {},
    );
    assert.equal(res.statusCode, 404);
  });

  test("keeps concurrent uploads and unrelated document metadata", async () => {
    const concurrent = { id: "doc-concurrent", uploadedBy: "staff-2", uploadedByRole: "staff" };
    const currentDocuments = {
      identity: [{ id: "doc-keep", uploadedBy: "customer-1" }],
      staffUploads: [concurrent],
    };
    applicationStore.findById = async () =>
      makeApplication({
        identity: currentDocuments.identity,
        staffUploads: [{ id: "doc-delete" }],
      });
    applicationStore.deleteDocumentById = async () => ({
      application: makeApplication(currentDocuments),
      deletedDocument: { id: "doc-delete" },
    });

    const res = makeResponse();
    await deleteStaffDocument(
      makeRequest("application-1", "doc-delete"),
      res as unknown as Response,
      () => {},
    );

    assert.deepEqual(
      (res.payload as { data: { documents: unknown } }).data.documents,
      currentDocuments,
    );
  });

  test("rejects roles outside the shared admin/staff route guard", () => {
    const res = makeResponse("customer");
    let continued = false;

    requireAdminOrStaff({} as Request, res as unknown as Response, () => {
      continued = true;
    });

    assert.equal(continued, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.payload, {
      success: false,
      error: { code: "FORBIDDEN", message: "Administrator or staff access is required." },
    });
  });
});

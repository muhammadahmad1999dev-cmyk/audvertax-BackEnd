import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { supabase } from "../../config/supabase.js";
import { applicationStore } from "./application.store.js";

const originalFindById = applicationStore.findById;
const originalFrom = supabase.from;

function application(documents: Record<string, unknown>, updatedAt: string) {
  return {
    id: "application-1",
    userId: "customer-1",
    serviceSlug: "uk-corporate-tax",
    status: "paid" as const,
    data: {},
    documents,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
  };
}

function databaseRow(documents: Record<string, unknown>, updatedAt: string) {
  return {
    id: "application-1",
    user_id: "customer-1",
    service_slug: "uk-corporate-tax",
    status: "paid",
    data: {},
    documents,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: updatedAt,
  };
}

describe("application document store concurrency", { concurrency: false }, () => {
  test.afterEach(() => {
    applicationStore.findById = originalFindById;
    supabase.from = originalFrom;
  });

  test("retries document append after a concurrent update and preserves it", async () => {
    const firstVersion = "2026-09-01T00:00:00.000Z";
    const concurrentVersion = "2026-09-01T00:00:01.000Z";
    const originalDocument = { id: "doc-original", uploadedBy: "customer-1" };
    const concurrentDocument = { id: "doc-concurrent", uploadedBy: "staff-2" };
    const appendedDocument = { id: "doc-new", uploadedBy: "admin-1" };
    const snapshots = [
      application({ identity: [originalDocument], staffUploads: [] }, firstVersion),
      application(
        { identity: [originalDocument], staffUploads: [concurrentDocument] },
        concurrentVersion,
      ),
    ];
    applicationStore.findById = async () => snapshots.shift() ?? null;

    let updateCount = 0;
    let currentRow = databaseRow(
      { identity: [originalDocument], staffUploads: [concurrentDocument] },
      concurrentVersion,
    );
    supabase.from = (() => {
      let changes: Record<string, unknown> = {};
      let expectedVersion = "";
      return {
        update(payload: Record<string, unknown>) {
          changes = payload;
          return this;
        },
        eq(column: string, value: string) {
          if (column === "updated_at") expectedVersion = value;
          return this;
        },
        select() {
          return this;
        },
        async maybeSingle() {
          updateCount += 1;
          if (updateCount === 1) return { data: null, error: null };
          assert.equal(expectedVersion, concurrentVersion);
          currentRow = { ...currentRow, ...changes } as typeof currentRow;
          return { data: currentRow, error: null };
        },
      };
    }) as unknown as typeof supabase.from;

    const updated = await applicationStore.appendStaffDocument("application-1", appendedDocument);

    assert.equal(updateCount, 2);
    assert.deepEqual(updated?.documents, {
      identity: [originalDocument],
      staffUploads: [concurrentDocument, appendedDocument],
    });
  });
});

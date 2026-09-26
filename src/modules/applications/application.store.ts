import crypto from "node:crypto";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../core/errors.js";
import type { Application } from "./application.types.js";

type ApplicationRow = {
  id: string;
  user_id: string;
  service_slug: string;
  status: Application["status"];
  data: Record<string, unknown>;
  documents: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function fromRow(row: ApplicationRow): Application {
  return {
    id: row.id,
    userId: row.user_id,
    serviceSlug: row.service_slug,
    status: row.status,
    data: row.data ?? {},
    documents: row.documents ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function removeDocument(
  value: unknown,
  documentId: string,
): {
  value: unknown;
  document: Record<string, unknown> | null;
} {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        if (record.id === documentId) {
          return {
            value: [...value.slice(0, index), ...value.slice(index + 1)],
            document: record,
          };
        }
      }

      const result = removeDocument(item, documentId);
      if (result.document) {
        const next = [...value];
        next[index] = result.value;
        return { value: next, document: result.document };
      }
    }
    return { value, document: null };
  }

  if (!value || typeof value !== "object") return { value, document: null };

  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const childRecord = child as Record<string, unknown>;
      if (childRecord.id === documentId) {
        const next = { ...record };
        delete next[key];
        return { value: next, document: childRecord };
      }
    }

    const result = removeDocument(child, documentId);
    if (result.document) {
      return { value: { ...record, [key]: result.value }, document: result.document };
    }
  }

  return { value, document: null };
}

async function updateDocumentsIfUnchanged(
  id: string,
  current: Application,
  documents: Record<string, unknown>,
) {
  const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
  const { data, error } = await supabase
    .from("applications")
    .update({ documents, updated_at: updatedAt })
    .eq("id", id)
    .eq("updated_at", current.updatedAt)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ? fromRow(data as ApplicationRow) : null;
}

export const applicationStore = {
  async listAll() {
    const { data, error } = await supabase
      .from("applications")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data as ApplicationRow[]).map(fromRow);
  },

  async listByUser(userId: string) {
    const { data, error } = await supabase
      .from("applications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data as ApplicationRow[]).map(fromRow);
  },

  async findById(id: string) {
    const { data, error } = await supabase
      .from("applications")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? fromRow(data as ApplicationRow) : null;
  },

  async create(data: Omit<Application, "id" | "createdAt" | "updatedAt">) {
    const { data: created, error } = await supabase
      .from("applications")
      .insert({
        id: "app_" + crypto.randomUUID(),
        user_id: data.userId,
        service_slug: data.serviceSlug,
        status: data.status,
        data: data.data,
        documents: data.documents,
      })
      .select("*")
      .single();

    if (error) throw error;
    return fromRow(created as ApplicationRow);
  },

  async update(id: string, changes: Partial<Application>) {
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (changes.userId !== undefined) payload.user_id = changes.userId;
    if (changes.serviceSlug !== undefined) payload.service_slug = changes.serviceSlug;
    if (changes.status !== undefined) payload.status = changes.status;
    if (changes.data !== undefined) payload.data = changes.data;
    if (changes.documents !== undefined) payload.documents = changes.documents;

    const { data, error } = await supabase
      .from("applications")
      .update(payload)
      .eq("id", id)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    return data ? fromRow(data as ApplicationRow) : null;
  },

  async appendStaffDocument(id: string, document: Record<string, unknown>) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await this.findById(id);
      if (!current) return null;

      const currentUploads = Array.isArray(current.documents.staffUploads)
        ? current.documents.staffUploads
        : [];
      const updated = await updateDocumentsIfUnchanged(id, current, {
        ...current.documents,
        staffUploads: [...currentUploads, document],
      });
      if (updated) return updated;
    }

    throw new AppError(
      "The application changed repeatedly while its documents were being updated. Please retry.",
      409,
      "APPLICATION_CONFLICT",
    );
  },

  async deleteDocumentById(id: string, documentId: string, staffOnly: boolean) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await this.findById(id);
      if (!current) return { application: null, deletedDocument: null };

      const target = staffOnly ? current.documents.staffUploads : current.documents;
      const result = removeDocument(target, documentId);
      if (!result.document) return { application: current, deletedDocument: null };

      const documents = staffOnly
        ? { ...current.documents, staffUploads: result.value }
        : (result.value as Record<string, unknown>);
      const updated = await updateDocumentsIfUnchanged(id, current, documents);
      if (updated) return { application: updated, deletedDocument: result.document };
    }

    throw new AppError(
      "The application changed repeatedly while its documents were being updated. Please retry.",
      409,
      "APPLICATION_CONFLICT",
    );
  },

  async delete(id: string) {
    const { error } = await supabase.from("applications").delete().eq("id", id);
    if (error) throw error;
  },
};

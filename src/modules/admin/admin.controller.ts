import type { Request, Response } from "express";
import argon2 from "argon2";
import { z } from "zod";
import { APPLICATION_STATUSES, type ApplicationStatus } from "../applications/application.types.js";
import {
  AdminApplicationLifecycleError,
  updateApplicationStatusAsAdmin,
} from "./admin.application.service.js";
import { applicationStore } from "../applications/application.store.js";
import { userStore } from "../auth/auth.store.js";
import { findOrder, listOrdersByUser, listPaidOrders, updateOrder } from "../billing/billing.store.js";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../core/errors.js";

function getParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const createStaffSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  password: z.string().min(6).max(128),
});

export async function createStaffController(req: Request, res: Response) {
  const input = createStaffSchema.parse(req.body);
  const email = input.email.toLowerCase();
  if (await userStore.findByEmail(email)) {
    res.status(409).json({
      success: false,
      error: {
        code: "EMAIL_ALREADY_EXISTS",
        message: "An account with this email already exists.",
      },
    });
    return;
  }

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  let staff;
  try {
    staff = await userStore.create({
      email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      role: "staff",
      authProvider: "password",
      googleSubject: null,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23514") {
      throw new AppError(
        "The staff role is not enabled in the database. Run the staff-role migration first.",
        503,
        "STAFF_ROLE_NOT_ENABLED",
      );
    }
    throw error;
  }
  const { passwordHash: _passwordHash, ...safeStaff } = staff;

  res.status(201).json({ success: true, data: { user: safeStaff } });
}

export async function listStaffController(_req: Request, res: Response) {
  const staff = await userStore.listByRole("staff");
  res.json({
    success: true,
    data: {
      staff: staff.map(({ passwordHash: _passwordHash, ...safeStaff }) => safeStaff),
    },
  });
}

export async function removeStaffController(req: Request, res: Response) {
  const staffId = getParam(req.params.id);
  const staff = staffId ? await userStore.findById(staffId) : null;
  if (!staff || staff.role !== "staff") {
    res.status(404).json({
      success: false,
      error: { code: "STAFF_NOT_FOUND", message: "Staff account not found." },
    });
    return;
  }

  await userStore.update(staff.id, { role: "customer" });
  res.json({
    success: true,
    data: { message: "Staff account removed successfully." },
  });
}

export async function listAdminApplicationsController(_req: Request, res: Response) {
  const isStaff = res.locals.user?.role === "staff";
  let applications = await applicationStore.listAll();
  if (isStaff) {
    const paidApplicationIds = new Set(
      (await listPaidOrders()).map((order) => order.applicationId),
    );
    applications = applications.filter((application) => paidApplicationIds.has(application.id));
  }
  const users = await Promise.all(
    applications.map((application) => userStore.findById(application.userId)),
  );

  const data = applications.map((application, index) => {
    const user = users[index];
    return {
      ...application,
      customer: user
        ? {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
          }
        : null,
    };
  });

  res.json({ success: true, data: { applications: data } });
}

export async function listAdminUsersController(_req: Request, res: Response) {
  const isStaff = res.locals.user?.role === "staff";
  let applications = await applicationStore.listAll();
  if (isStaff) {
    const paidApplicationIds = new Set(
      (await listPaidOrders()).map((order) => order.applicationId),
    );
    applications = applications.filter((application) => paidApplicationIds.has(application.id));
  }

  const applicationsByUser = new Map<string, typeof applications>();
  applications.forEach((application) => {
    const userApplications = applicationsByUser.get(application.userId) ?? [];
    userApplications.push(application);
    applicationsByUser.set(application.userId, userApplications);
  });

  const users = await Promise.all(
    [...applicationsByUser.entries()].map(async ([userId, userApplications]) => {
      const user = await userStore.findById(userId);
      if (!user) return null;
      return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        applications: userApplications,
      };
    }),
  );

  res.json({ success: true, data: { users: users.filter((user) => user !== null) } });
}

export async function updateUserPaymentStatusController(req: Request, res: Response) {
  const userId = getParam(req.params.id);
  const body = req.body as { status?: string };

  if (!userId) {
    res.status(400).json({
      success: false,
      error: { code: "INVALID_USER_ID", message: "User ID is required." },
    });
    return;
  }

  if (body.status !== "paid") {
    res.status(400).json({
      success: false,
      error: { code: "INVALID_PAYMENT_STATUS", message: "Only the paid status is supported." },
    });
    return;
  }

  const user = await userStore.findById(userId);
  if (!user) {
    res.status(404).json({
      success: false,
      error: { code: "USER_NOT_FOUND", message: "User not found." },
    });
    return;
  }

  const orders = await listOrdersByUser(userId);
  const pendingOrders = orders.filter((order) => order.status === "pending");
  if (!pendingOrders.length) {
    res.status(404).json({
      success: false,
      error: { code: "PAYMENT_NOT_FOUND", message: "No pending payment was found for this user." },
    });
    return;
  }

  for (const order of pendingOrders) {
    await updateOrder(order.id, { status: "paid" });
    const application = await applicationStore.findById(order.applicationId);
    if (application && application.userId === userId) {
      await applicationStore.update(application.id, { status: "paid" });
    }
  }

  res.json({
    success: true,
    data: { status: "paid", updatedOrders: pendingOrders.length },
  });
}

export async function updateAdminApplicationStatusController(req: Request, res: Response) {
  const applicationId = getParam(req.params.id);
  const body = req.body as {
    status?: ApplicationStatus;
    expectedUpdatedAt?: string;
  };

  if (!applicationId) {
    res.status(400).json({
      success: false,
      error: { code: "INVALID_APPLICATION_ID", message: "Application ID is required." },
    });
    return;
  }

  const adminStatuses: ApplicationStatus[] = ["processing", "completed", "cancelled"];

  if (!adminStatuses.includes(body.status as ApplicationStatus)) {
    res.status(400).json({
      success: false,
      error: { code: "INVALID_STATUS", message: "A valid application status is required." },
    });
    return;
  }

  if (typeof body.expectedUpdatedAt !== "string" || !body.expectedUpdatedAt) {
    res.status(400).json({
      success: false,
      error: {
        code: "MISSING_APPLICATION_VERSION",
        message: "expectedUpdatedAt is required when updating an application status.",
      },
    });
    return;
  }

  try {
    const application = await updateApplicationStatusAsAdmin(
      applicationId,
      body.status as ApplicationStatus,
      body.expectedUpdatedAt,
    );

    if (!application) {
      res.status(404).json({
        success: false,
        error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." },
      });
      return;
    }

    res.json({ success: true, data: { application } });
  } catch (error) {
    if (error instanceof AdminApplicationLifecycleError) {
      res.status(error.code === "APPLICATION_CONFLICT" ? 409 : 409).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    throw error;
  }
}

export async function getAdminApplicationController(req: Request, res: Response) {
  const applicationId = getParam(req.params.id ?? req.params.applicationId);
  if (!applicationId)
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_APPLICATION_ID", message: "Application ID is required." },
    });
  const application = await applicationStore.findById(applicationId);
  if (!application)
    return res.status(404).json({
      success: false,
      error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." },
    });
  const billing = await findOrder(application.id, application.userId);
  if (res.locals.user?.role === "staff" && billing?.status !== "paid")
    return res.status(404).json({
      success: false,
      error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." },
    });
  const user = await userStore.findById(application.userId);
  const documentPaths: string[] = [];
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string") documentPaths.push(record.path);
    Object.values(record).forEach(collect);
  };
  collect(application.documents);
  const signedDocuments = await Promise.all(
    documentPaths.map(async (path) => {
      const { data } = await supabase.storage
        .from("application-documents")
        .createSignedUrl(path, 60 * 10);
      return { path, url: data?.signedUrl ?? null };
    }),
  );
  res.json({
    success: true,
    data: {
      application,
      customer: user
        ? { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }
        : null,
      billing,
      signedDocuments,
    },
  });
}

import { getApplication } from "../applications/application.service.js";
import { createOrderIfAbsent, findOrder, listOrdersByUser, updateOrder } from "./billing.store.js";
import { calculateBillingPricing } from "./billing.pricing.js";
import { getApplicationMode } from "../commercial/application-mode.js";
import { applicationStore } from "../applications/application.store.js";
import Stripe from "stripe";
import { env } from "../../config/env.js";

function stripeClient() {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not configured");
  return new Stripe(env.STRIPE_SECRET_KEY);
}

function commercialSelection(application: Awaited<ReturnType<typeof getApplication>>) {
  if (!application) return null;

  const data = application.data;
  const packageSlug =
    typeof data.packageSlug === "string"
      ? data.packageSlug
      : typeof data.package === "string"
        ? data.package
        : undefined;
  const formationState =
    typeof data.formationState === "string"
      ? data.formationState
      : typeof data.state === "string"
        ? data.state
        : undefined;
  const variantSlug = typeof data.variantSlug === "string" ? data.variantSlug : undefined;
  const addOnSlugs = Array.isArray(data.addOnSlugs)
    ? data.addOnSlugs.filter((value): value is string => typeof value === "string")
    : data.optional_services &&
        typeof data.optional_services === "object" &&
        (data.optional_services as Record<string, unknown>).wise_account_setup === true
      ? ["wise-account-setup"]
      : [];

  return {
    serviceSlug: application.serviceSlug,
    packageSlug,
    formationState,
    variantSlug,
    addOnSlugs,
  };
}

export async function getBilling(userId: string, applicationId: string) {
  const application = await getApplication(applicationId);
  if (
    !application ||
    application.userId !== userId ||
    getApplicationMode(application.serviceSlug) !== "paid"
  )
    return null;
  return findOrder(applicationId, userId);
}

export async function listBilling(userId: string) {
  const orders = await listOrdersByUser(userId);
  const paidApplicationIds = orders
    .filter((order) => order.status === "paid")
    .map((order) => order.applicationId);
  for (const applicationId of paidApplicationIds) {
    const application = await getApplication(applicationId);
    if (
      application &&
      application.userId === userId &&
      application.status === "ready_for_payment"
    ) {
      await applicationStore.update(applicationId, { status: "paid" });
    }
  }
  return orders;
}

export async function reconcilePaidApplicationStatus(userId: string, applicationId: string) {
  const order = await findOrder(applicationId, userId);
  const application = await getApplication(applicationId);
  if (order?.status === "paid" && application?.userId === userId && application.status !== "paid") {
    return applicationStore.update(applicationId, { status: "paid" });
  }
  return application;
}

export async function createBillingOrder(userId: string, applicationId: string) {
  const application = await getApplication(applicationId);
  if (
    !application ||
    application.userId !== userId ||
    getApplicationMode(application.serviceSlug) !== "paid"
  )
    return null;
  if (application.status !== "ready_for_payment") return null;

  const selection = commercialSelection(application);
  if (!selection) return null;
  const pricing = calculateBillingPricing(
    selection.serviceSlug,
    selection.packageSlug,
    selection.formationState,
    selection.addOnSlugs,
    selection.variantSlug,
  );
  if (!pricing) return null;

  return createOrderIfAbsent({
    applicationId,
    userId,
    lineItems: pricing.lineItems,
    subtotal: pricing.subtotal,
    total: pricing.total,
    currency: pricing.currency,
    status: "pending",
  });
}

export async function createStripeCheckoutSession(userId: string, applicationId: string) {
  const order = await getBilling(userId, applicationId);
  if (!order || order.status !== "pending") return null;

  const session = await stripeClient().checkout.sessions.create({
    mode: "payment",
    line_items: order.lineItems.map((item) => ({
      price_data: {
        currency: item.currency.toLowerCase(),
        product_data: { name: item.label },
        unit_amount: Math.round(item.unitAmount * 100),
      },
      quantity: item.quantity,
    })),
    metadata: { applicationId, userId, orderId: order.id },
    client_reference_id: applicationId,
    success_url: `${env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.FRONTEND_URL}/payment/cancelled?application_id=${encodeURIComponent(applicationId)}`,
  });

  return { id: session.id, url: session.url };
}

export async function markStripePaymentPaid(applicationId: string, userId: string) {
  const application = await getApplication(applicationId);
  if (!application || application.userId !== userId) return null;

  const order = await findOrder(applicationId, userId);
  if (!order) return null;
  if (order.status === "paid") return order;

  const paidOrder = await updateOrder(order.id, { status: "paid" });
  if (paidOrder) await applicationStore.update(applicationId, { status: "paid" });
  return paidOrder;
}

import type { Request, Response } from "express";
import Stripe from "stripe";
import { env } from "../../config/env.js";
import {
  createBillingOrder,
  createStripeCheckoutSession,
  getBilling,
  listBilling,
  markStripePaymentPaid,
} from "./billing.service.js";

function userId(res: Response) {
  return res.locals.user?.id as string | undefined;
}

export async function listBillingController(_req: Request, res: Response) {
  const id = userId(res);
  if (!id)
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  return res.json({ success: true, data: await listBilling(id) });
}

export async function getBillingController(req: Request, res: Response) {
  const id = userId(res);
  if (!id)
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  const applicationId = req.params.applicationId;
  if (!applicationId)
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_APPLICATION_ID", message: "Application ID is required." },
    });
  const billing = await getBilling(id, String(applicationId));
  if (!billing)
    return res.status(404).json({
      success: false,
      error: {
        code: "BILLING_NOT_FOUND",
        message: "Billing information is not available for this application.",
      },
    });
  return res.json({ success: true, data: billing });
}

export async function createOrderController(req: Request, res: Response) {
  const id = userId(res);
  if (!id)
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  const applicationId = req.params.applicationId;
  if (!applicationId)
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_APPLICATION_ID", message: "Application ID is required." },
    });
  const order = await createBillingOrder(id, String(applicationId));
  if (!order)
    return res.status(409).json({
      success: false,
      error: { code: "ORDER_UNAVAILABLE", message: "This application is not ready for payment." },
    });
  return res.status(201).json({ success: true, data: order });
}

export async function createCheckoutSessionController(req: Request, res: Response) {
  const id = userId(res);
  if (!id)
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });

  const applicationId = req.params.applicationId;
  if (!applicationId)
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_APPLICATION_ID", message: "Application ID is required." },
    });

  const session = await createStripeCheckoutSession(id, String(applicationId));
  if (!session)
    return res.status(409).json({
      success: false,
      error: {
        code: "CHECKOUT_UNAVAILABLE",
        message: "This application is not ready for payment.",
      },
    });

  return res.status(201).json({ success: true, data: session });
}

export async function stripeWebhookController(req: Request, res: Response) {
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_WEBHOOK", message: "Invalid Stripe webhook request." },
    });
  }

  let event: Stripe.Event;
  try {
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)
      throw new Error("Stripe is not configured");
    event = new Stripe(env.STRIPE_SECRET_KEY).webhooks.constructEvent(
      req.body,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_WEBHOOK", message: "Invalid Stripe webhook signature." },
    });
  }

  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status === "paid") {
      const applicationId = session.metadata?.applicationId;
      const userId = session.metadata?.userId;
      if (applicationId && userId) await markStripePaymentPaid(applicationId, userId);
    }
  }

  return res.json({ received: true });
}

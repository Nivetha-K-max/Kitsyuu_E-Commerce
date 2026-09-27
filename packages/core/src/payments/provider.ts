/* Payment provider interface (M7). Checkout and orders only know this interface; a provider (Razorpay, another gateway,
   the development test provider) plugs in behind it, so adding or switching one does not touch checkout or orders.

   Trust rule for every provider: a payment counts only when the PROVIDER confirms it — a signature made with a secret the
   browser does not have plus, where the provider offers it, reading the payment back from the provider's API — or when a
   signed provider notification (webhook) reports it. What the browser says is never enough. */

export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';

/** A payment as the provider reports it. */
export interface ProviderPayment {
  id: string;                    // the provider's payment id
  sessionRef: string;            // the provider's reference for the checkout session (e.g. a Razorpay order id)
  amountPaise: number;
  currency: string;
  status: ProviderPaymentStatus;
  method: string | null;
  failureReason: string | null;
  raw?: unknown;                 // provider payload, kept for reconciliation
}

/** What the browser needs to start the provider's payment step. Public values only (never a secret). */
export interface PaymentSession { sessionRef: string; client: Record<string, unknown> }

export interface PaymentOrderInfo {
  orderId: string; orderNumber: string; amountPaise: number; currency: string;
  contact: { name: string | null; email: string | null; phone: string | null };
}

export interface PaymentProvider {
  /** Stored in payments.provider, e.g. 'razorpay', 'test'. */
  readonly code: string;
  /** Shown to customers, e.g. 'Razorpay', 'Test payment'. */
  readonly label: string;
  /** Starts a payment for an order (e.g. creates a Razorpay order). */
  createSession(order: PaymentOrderInfo): Promise<PaymentSession>;
  /** Checks what the provider's browser widget reported for a session and returns the payment as the provider confirms it,
      or null when it cannot be verified (bad signature, another session, unknown payment). */
  verifyClientResult(sessionRef: string, result: Record<string, string>): Promise<ProviderPayment | null>;
  /** Payments the provider holds for a session (reconciliation, expiry), or null when the provider cannot say. */
  listPayments(sessionRef: string): Promise<ProviderPayment[] | null>;
  /** Authenticates and reads a provider notification; null when its signature is not valid. Providers without
      notifications omit it. */
  parseWebhook?(rawBody: string, header: (name: string) => string | null):
    { eventId: string; type: string; payment: ProviderPayment | null } | null;
}

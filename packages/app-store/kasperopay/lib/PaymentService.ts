import { v4 as uuidv4 } from "uuid";
import type z from "zod";

import { ErrorCode } from "@calcom/lib/errorCodes";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import prisma from "@calcom/prisma";
import type { Booking, Payment, PaymentOption, Prisma } from "@calcom/prisma/client";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { IAbstractPaymentService } from "@calcom/types/PaymentService";

import { kasperopayCredentialKeysSchema } from "./kasperopayCredentialKeysSchema";

const log = logger.getSubLogger({ prefix: ["payment-service:kasperopay"] });

const KASPEROPAY_API_URL = process.env.KASPEROPAY_API_URL || "https://kasperopay.com";

interface KasperoPayInitResponse {
  success: boolean;
  session_id?: string;
  token?: string;
  expires_at?: string;
  amount_kas?: number;
  payment_url?: string;
  error?: string;
}

class KasperoPayPaymentService implements IAbstractPaymentService {
  private credentials: z.infer<typeof kasperopayCredentialKeysSchema> | null;

  constructor(credentials: { key: Prisma.JsonValue }) {
    const keyParsing = kasperopayCredentialKeysSchema.safeParse(credentials.key);
    if (keyParsing.success) {
      this.credentials = keyParsing.data;
    } else {
      this.credentials = null;
    }
  }

  async create(
    payment: Pick<Prisma.PaymentUncheckedCreateInput, "amount" | "currency">,
    bookingId: Booking["id"]
  ) {
    try {
      const booking = await prisma.booking.findUnique({
        select: {
          uid: true,
          title: true,
        },
        where: {
          id: bookingId,
        },
      });

      if (!booking || !this.credentials?.merchant_id) {
        throw new Error("KasperoPay: Booking or merchant ID not found");
      }

      const uid = uuidv4();

      // Call KasperoPay API to initialize payment session
      log.info("KasperoPay: Calling API at", `${KASPEROPAY_API_URL}/pay/init`);
      const initResponse = await fetch(`${KASPEROPAY_API_URL}/pay/init`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Cal.com/KasperoPay",
        },
        body: JSON.stringify({
          merchant_id: this.credentials.merchant_id,
          amount: payment.amount,
          currency: payment.currency,
          item: booking.title || "Cal.com Booking",
          metadata: {
            appId: "cal.com",
            referenceId: uid,
            bookingUid: booking.uid,
          },
        }),
      });

      const initText = await initResponse.text();
      log.info("KasperoPay: Response status", initResponse.status, "body preview:", initText.substring(0, 200));
      const initData: KasperoPayInitResponse = JSON.parse(initText);

      if (!initData.success || !initData.session_id) {
        log.error("KasperoPay: Failed to initialize payment", { session_id: initData.session_id, error: initData.error, success: initData.success });
        throw new Error(initData.error || "Failed to initialize KasperoPay session");
      }

      // Create payment record in Cal.com database
      const paymentData = await prisma.payment.create({
        data: {
          uid,
          app: {
            connect: {
              slug: "kasperopay",
            },
          },
          booking: {
            connect: {
              id: bookingId,
            },
          },
          amount: payment.amount,
          externalId: initData.session_id, // Store KasperoPay session_id
          currency: payment.currency,
          data: Object.assign(
            {},
            {
              session: {
                session_id: initData.session_id,
                token: initData.token,
                expires_at: initData.expires_at,
                amount_kas: initData.amount_kas,
                isPaid: false,
              },
            }
          ) as unknown as Prisma.InputJsonValue,
          fee: 0,
          refunded: false,
          success: false,
        },
      });

      if (!paymentData) {
        throw new Error("Failed to create payment record");
      }

      return paymentData;
    } catch (error) {
      log.error("KasperoPay: Payment could not be created", bookingId, safeStringify(error));
      throw new Error(ErrorCode.PaymentCreationFailure);
    }
  }

  async update(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }

  async refund(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }

  async collectCard(
    _payment: Pick<Prisma.PaymentUncheckedCreateInput, "amount" | "currency">,
    _bookingId: number,
    _bookerEmail: string,
    _paymentOption: PaymentOption
  ): Promise<Payment> {
    throw new Error("Method not implemented");
  }

  chargeCard(
    _payment: Pick<Prisma.PaymentUncheckedCreateInput, "amount" | "currency">,
    _bookingId: number
  ): Promise<Payment> {
    throw new Error("Method not implemented.");
  }

  getPaymentPaidStatus(): Promise<string> {
    throw new Error("Method not implemented.");
  }

  getPaymentDetails(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }

  afterPayment(
    _event: CalendarEvent,
    _booking: {
      user: { email: string | null; name: string | null; timeZone: string } | null;
      id: number;
      startTime: { toISOString: () => string };
      uid: string;
    },
    _paymentData: Payment
  ): Promise<void> {
    return Promise.resolve();
  }

  deletePayment(_paymentId: number): Promise<boolean> {
    return Promise.resolve(false);
  }

  isSetupAlready(): boolean {
    return true;
  }
}

/**
 * Factory function that creates a KasperoPay Payment service instance.
 */
export function BuildPaymentService(credentials: { key: Prisma.JsonValue }): IAbstractPaymentService {
  return new KasperoPayPaymentService(credentials);
}

# KasperoPay Server Changes for Cal.com Integration

## Summary

Your existing `/pay/init` endpoint is mostly ready. You need to:
1. Accept and store `metadata` in payment sessions
2. Pass `metadata` back in webhook payloads
3. Add webhook_secret to merchant credentials

---

## 1. Modify `/pay/init` to Accept Metadata

In `routes_pay.js`, update the init endpoint to accept and store metadata:

### Find this section (~line 267):
```javascript
const { merchant_id, amount, currency, item, image_url, items } = req.body;
```

### Replace with:
```javascript
const { merchant_id, amount, currency, item, image_url, items, metadata } = req.body;
```

### Find the INSERT query (~line 373) and add metadata column:
```javascript
await db.query(
    `INSERT INTO payment_sessions 
     (session_id, merchant_id, amount_kas, item_description, image_url, items, token_hash, 
      status, ip_address, user_agent, expires_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [
        sessionId,
        merchant_id,
        amountKas,
        sanitizedItem,
        sanitizedImage,
        sanitizedItems,
        tokenHash,
        req.ip || req.connection.remoteAddress,
        sanitizeString(req.get('User-Agent'), 500),
        expiresAt,
        metadata ? JSON.stringify(metadata) : null  // ADD THIS
    ]
);
```

---

## 2. Add Metadata Column to Database

Run this SQL:

```sql
ALTER TABLE payment_sessions 
ADD COLUMN metadata JSON DEFAULT NULL;

ALTER TABLE merchant_payments 
ADD COLUMN metadata JSON DEFAULT NULL;
```

---

## 3. Pass Metadata to merchant_payments on Payment Creation

When creating the payment record, copy metadata from session:

### Find where you insert into merchant_payments and add:
```javascript
metadata: session.metadata || null
```

---

## 4. Include Metadata in Webhook Payload

In your `sendWebhook` function (~line 141), the payload already includes metadata:

```javascript
const payload = {
    event: 'payment.completed',
    timestamp: new Date().toISOString(),
    merchant_id: payment.merchant_string_id,
    payment_id: payment.payment_id,
    order_id: payment.order_id || null,
    amount_kas: payment.amount_kas,
    amount_usd: payment.amount_usd,
    transaction_id: txid || payment.txid || null,
    customer_address: payment.customer_address,
    item: payment.item_description,
    metadata: payment.metadata ? JSON.parse(payment.metadata) : {}  // ALREADY EXISTS
};
```

Just make sure `payment.metadata` is populated from the payment record.

---

## 5. Add Cal.com Webhook URL Support

Cal.com will receive webhooks at:
```
https://app.cal.com/api/integrations/kasperopay/webhook
```

Merchants using Cal.com need to set their webhook URL to this endpoint.

**Option A**: Auto-configure when Cal.com creates a payment (via metadata)
**Option B**: Merchant manually sets webhook URL in their KasperoPay dashboard

For now, Option B is simpler - just tell Victor to set his webhook URL.

---

## 6. Webhook Signature (Optional but Recommended)

Add signature header when sending webhooks:

```javascript
async function sendWebhook(payment, txid) {
    if (!payment.webhook_url) return;
    
    const payload = {
        event: 'payment.completed',
        timestamp: new Date().toISOString(),
        merchant_id: payment.merchant_string_id,
        payment_id: payment.payment_id,
        // ... rest of payload
    };
    
    const payloadString = JSON.stringify(payload);
    
    // Generate signature if merchant has webhook_secret
    const headers = {
        'Content-Type': 'application/json'
    };
    
    if (payment.webhook_secret) {
        const signature = crypto
            .createHmac('sha256', payment.webhook_secret)
            .update(payloadString)
            .digest('hex');
        headers['X-KasperoPay-Signature'] = signature;
    }
    
    try {
        const response = await fetch(payment.webhook_url, {
            method: 'POST',
            headers,
            body: payloadString
        });
        console.log('[Webhook] Sent to', payment.webhook_url, '- Status:', response.status);
    } catch (err) {
        console.error('[Webhook] Failed:', err.message);
    }
}
```

---

## Quick Test

1. Create a payment via `/pay/init` with metadata:
```bash
curl -X POST https://kasperopay.com/pay/init \
  -H "Content-Type: application/json" \
  -d '{
    "merchant_id": "kpm_test123",
    "amount": 10,
    "currency": "KAS",
    "item": "Test Booking",
    "metadata": {
      "appId": "cal.com",
      "referenceId": "test-uuid-123",
      "bookingUid": "booking-abc"
    }
  }'
```

2. Verify response includes session_id
3. Complete a payment
4. Verify webhook includes metadata

---

## Summary of Changes

| File | Change |
|------|--------|
| `routes_pay.js` | Add metadata to /pay/init body parsing |
| `routes_pay.js` | Add metadata to payment_sessions INSERT |
| `routes_pay.js` | Pass metadata to merchant_payments |
| `routes_pay.js` | Add signature header to webhook |
| Database | Add metadata column to payment_sessions |
| Database | Add metadata column to merchant_payments |

Total: ~20 lines of code changes + 2 SQL statements.

# KasperoPay Server Code Changes for Cal.com

These are the exact code changes needed for `routes_pay.js` to support Cal.com integration.

---

## 1. SQL: Add metadata columns

Run this SQL first:

```sql
ALTER TABLE payment_sessions ADD COLUMN metadata JSON DEFAULT NULL;
ALTER TABLE merchant_payments ADD COLUMN metadata JSON DEFAULT NULL;
```

---

## 2. Update `/pay/init` endpoint

### Find this line (~line 267):
```javascript
const { merchant_id, amount, currency, item, image_url, items } = req.body;
```

### Replace with:
```javascript
const { merchant_id, amount, currency, item, image_url, items, metadata, webhook_url } = req.body;
```

---

### Find the sanitization section and add after `sanitizeItems`:
```javascript
// Sanitize metadata (for Cal.com and other integrations)
function sanitizeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    // Only allow specific keys
    const allowed = ['appId', 'referenceId', 'bookingUid', 'orderId', 'customerId'];
    const sanitized = {};
    for (const key of allowed) {
        if (metadata[key]) {
            sanitized[key] = sanitizeString(String(metadata[key]), 100);
        }
    }
    return Object.keys(sanitized).length > 0 ? JSON.stringify(sanitized) : null;
}
```

---

### Find the INSERT into payment_sessions (~line 373) and replace:

**Old:**
```javascript
await db.query(
    `INSERT INTO payment_sessions 
     (session_id, merchant_id, amount_kas, item_description, image_url, items, token_hash, 
      status, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
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
        expiresAt
    ]
);
```

**New:**
```javascript
const sanitizedMetadata = sanitizeMetadata(metadata);
const sanitizedWebhookUrl = webhook_url ? sanitizeUrl(webhook_url) : null;

await db.query(
    `INSERT INTO payment_sessions 
     (session_id, merchant_id, amount_kas, item_description, image_url, items, token_hash, 
      status, ip_address, user_agent, expires_at, metadata, webhook_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
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
        sanitizedMetadata,
        sanitizedWebhookUrl
    ]
);
```

---

## 3. Pass metadata when creating merchant_payments

Find where you INSERT into `merchant_payments` when a payment is confirmed (likely in your payment confirmation logic), and add the metadata:

```javascript
// When creating the merchant_payment record, include metadata from session
await db.query(
    `INSERT INTO merchant_payments 
     (payment_id, merchant_id, ..., metadata, webhook_url)
     VALUES (?, ?, ..., ?, ?)`,
    [
        paymentId,
        merchantId,
        // ... other fields
        session.metadata,  // Pass through from session
        session.webhook_url
    ]
);
```

---

## 4. Update sendWebhook function with signature

### Find (~line 141):
```javascript
async function sendWebhook(payment, txid) {
    if (!payment.webhook_url) return;
    
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
        metadata: payment.metadata ? JSON.parse(payment.metadata) : {}
    };
    
    try {
        const response = await fetch(payment.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log('[Webhook] Sent to', payment.webhook_url, '- Status:', response.status);
    } catch (err) {
        console.error('[Webhook] Failed:', err.message);
    }
}
```

### Replace with:
```javascript
async function sendWebhook(payment, txid) {
    if (!payment.webhook_url) return;
    
    const payload = {
        event: 'payment.completed',
        timestamp: new Date().toISOString(),
        merchant_id: payment.merchant_string_id,
        payment_id: payment.payment_id,
        order_id: payment.order_id || null,
        amount_kas: String(payment.amount_kas),
        amount_usd: payment.amount_usd ? String(payment.amount_usd) : null,
        transaction_id: txid || payment.txid || null,
        customer_address: payment.customer_address,
        item: payment.item_description,
        metadata: payment.metadata ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata) : {}
    };
    
    const payloadString = JSON.stringify(payload);
    
    // Build headers
    const headers = {
        'Content-Type': 'application/json'
    };
    
    // Add signature if merchant has webhook_secret configured
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

## 5. Add webhook_url column to payment_sessions

```sql
ALTER TABLE payment_sessions ADD COLUMN webhook_url VARCHAR(500) DEFAULT NULL;
```

---

## Summary of Changes

| Location | Change |
|----------|--------|
| SQL | Add `metadata` column to `payment_sessions` |
| SQL | Add `metadata` column to `merchant_payments` |
| SQL | Add `webhook_url` column to `payment_sessions` |
| routes_pay.js | Accept `metadata` and `webhook_url` in /pay/init |
| routes_pay.js | Add `sanitizeMetadata()` function |
| routes_pay.js | Store metadata in payment_sessions INSERT |
| routes_pay.js | Pass metadata through to merchant_payments |
| routes_pay.js | Add signature header to sendWebhook |

**Total: ~30 lines of code changes + 3 SQL statements**

---

## Testing

After making these changes, test with:

```bash
curl -X POST https://kasperopay.com/pay/init \
  -H "Content-Type: application/json" \
  -d '{
    "merchant_id": "kpm_your_test_id",
    "amount": 10,
    "currency": "KAS",
    "item": "Cal.com Test Booking",
    "metadata": {
      "appId": "cal.com",
      "referenceId": "test-uuid-123",
      "bookingUid": "booking-abc"
    },
    "webhook_url": "https://webhook.site/your-test-url"
  }'
```

Verify:
1. Response includes `session_id`
2. After payment, webhook is sent with metadata included
3. Signature header is present if webhook_secret is set

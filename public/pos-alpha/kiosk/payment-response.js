// An HTTP 2xx or a pair of status strings is not a usable payment snapshot.
// Validate before replacing current state or discarding the attempted cart.
export function assertPaymentResponse(result, expected = {}) {
  const order = result?.order;
  const payment = result?.payment;
  const money = value => Number.isSafeInteger(value) && value >= 0;
  const id = value => typeof value === "string" && value.trim().length > 0;
  const receiptItem = item => item && typeof item === "object"
    && Number.isSafeInteger(item.qty) && item.qty > 0
    && [item.productNameSnapshot, item.name, item.productId].some(id)
    && (item.unitPriceRupiah === undefined || money(item.unitPriceRupiah))
    && (item.lineTotalRupiah === undefined || money(item.lineTotalRupiah))
    && (item.note === undefined || typeof item.note === "string")
    && (item.selections === undefined || (Array.isArray(item.selections)
      && item.selections.every(selection => selection && typeof selection === "object" && !Array.isArray(selection)
        && (selection.optionLabel === undefined || typeof selection.optionLabel === "string")
        && (selection.option === undefined || typeof selection.option === "string"))));
  if (!id(order?.id) || !id(payment?.id) || payment.orderId !== order.id
    || !id(order.status) || !id(payment.status)
    || !Array.isArray(order.items) || !order.items.length
    || !order.items.every(receiptItem)
    || !money(order.totalRupiah) || !money(payment.amountRupiah)
    || payment.amountRupiah !== order.totalRupiah
    || (expected.orderId && order.id !== expected.orderId)
    || (expected.paymentId && payment.id !== expected.paymentId)) {
    const error = new Error("Detail pembayaran belum lengkap. Periksa kembali tanpa membayar ulang.");
    error.code = "payment_response_invalid";
    throw error;
  }
  return result;
}

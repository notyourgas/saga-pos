export const SCREENS = Object.freeze({
  WELCOME: "welcome",
  ORDER_TYPE: "order-type",
  BROWSE: "browse",
  MODIFIER: "modifier",
  CART: "cart",
  MEMBER: "member",
  MEMBER_WELCOME: "member-welcome",
  PAYMENT_METHOD: "payment-method",
  PAYMENT_PENDING: "payment-pending",
  PAYMENT_RECOVERY: "payment-recovery",
  SUCCESS: "success",
  OUT_OF_SERVICE: "out-of-service",
});

const transitions = Object.freeze({
  [SCREENS.WELCOME]: [SCREENS.ORDER_TYPE, SCREENS.OUT_OF_SERVICE],
  [SCREENS.ORDER_TYPE]: [SCREENS.WELCOME, SCREENS.MEMBER, SCREENS.BROWSE],
  [SCREENS.MEMBER]: [SCREENS.ORDER_TYPE, SCREENS.MEMBER_WELCOME, SCREENS.BROWSE, SCREENS.CART],
  [SCREENS.MEMBER_WELCOME]: [SCREENS.MEMBER, SCREENS.BROWSE, SCREENS.MODIFIER],
  [SCREENS.BROWSE]: [SCREENS.MEMBER, SCREENS.MEMBER_WELCOME, SCREENS.MODIFIER, SCREENS.CART, SCREENS.OUT_OF_SERVICE],
  [SCREENS.MODIFIER]: [SCREENS.MEMBER_WELCOME, SCREENS.BROWSE, SCREENS.CART],
  [SCREENS.CART]: [SCREENS.BROWSE, SCREENS.MODIFIER, SCREENS.MEMBER, SCREENS.PAYMENT_METHOD],
  [SCREENS.PAYMENT_METHOD]: [SCREENS.CART, SCREENS.PAYMENT_PENDING, SCREENS.SUCCESS],
  [SCREENS.PAYMENT_PENDING]: [SCREENS.PAYMENT_RECOVERY, SCREENS.SUCCESS],
  [SCREENS.PAYMENT_RECOVERY]: [SCREENS.PAYMENT_PENDING, SCREENS.SUCCESS, SCREENS.OUT_OF_SERVICE],
  [SCREENS.SUCCESS]: [SCREENS.WELCOME],
  [SCREENS.OUT_OF_SERVICE]: [SCREENS.WELCOME],
});

export function createFlowMachine(initial = SCREENS.WELCOME) {
  let current = initial;
  return Object.freeze({
    get current() { return current; },
    can(next) { return transitions[current]?.includes(next) ?? false; },
    go(next) {
      if (!transitions[current]?.includes(next)) throw new Error(`illegal_kiosk_transition:${current}:${next}`);
      current = next;
      return current;
    },
    restore(next) {
      if (!Object.values(SCREENS).includes(next)) throw new Error(`unknown_kiosk_screen:${next}`);
      current = next;
      return current;
    },
  });
}

export function screenForPayment(payment, order) {
  if (payment?.status === "PAID" && ["PAID", "COMPLETED"].includes(order?.status)) return SCREENS.SUCCESS;
  if (["EXPIRED", "FAILED", "CANCELLED", "UNKNOWN"].includes(payment?.status)) return SCREENS.PAYMENT_RECOVERY;
  return SCREENS.PAYMENT_PENDING;
}

/* Customer wording for ERP module states (returns, support tickets). Never internal codes, no promises. */
export const RETURN_STATUS_LABEL: Record<string, string> = {
  requested: 'Requested', under_review: 'Being reviewed', info_requested: 'We need more information', approved: 'Approved', rejected: 'Not accepted',
  pickup_scheduled: 'Pickup scheduled', picked_up: 'Picked up', received: 'Received by us', inspection: 'Being checked', refund_pending: 'Refund being prepared',
  refunded: 'Refunded', exchange_pending: 'Exchange being prepared', exchanged: 'Replacement sent', completed: 'Completed', cancelled: 'Cancelled',
};
export const TICKET_STATUS_LABEL: Record<string, string> = {
  open: 'Open', assigned: 'With our team', in_progress: 'With our team', waiting_customer: 'Waiting for your reply', resolved: 'Resolved', closed: 'Closed',
};

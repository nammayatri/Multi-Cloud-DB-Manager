import { Router } from 'express';
import {
  createRequest,
  listMyRequests,
  listPendingApprovals,
  listReviewed,
  getPendingCount,
  getRequest,
  approveRequest,
  rejectRequest,
  cancelRequest,
  getRequestResult,
  updateRequest,
  getGroup,
  approveGroup,
  rejectGroup,
  cancelGroup,
  updateReason,
} from '../controllers/queryRequests.controller';
import { isAuthenticated } from '../middleware/auth.middleware';
import {
  validate,
  queryRequestCreateSchema,
  queryRequestApproveSchema,
  queryRequestRejectSchema,
  queryRequestUpdateSchema,
  queryRequestReasonSchema,
} from '../middleware/validation.middleware';

const router = Router();

// Every route is authenticated. There is no role gate at this layer on purpose:
// who may approve depends on the QUERY, not on a fixed role list, so each
// handler evaluates the viewer's role against the specific request.
router.use(isAuthenticated);

// Submit a request — one or more queries, each with its own target. There is
// deliberately only one creation endpoint: a request is always a group.
router.post('/', validate(queryRequestCreateSchema), createRequest);

// Every query in a request
router.get('/groups/:groupId', getGroup);

// Approve every pending query in a request and run them in order
router.post('/groups/:groupId/approve', validate(queryRequestApproveSchema), approveGroup);
router.post('/groups/:groupId/reject', validate(queryRequestRejectSchema), rejectGroup);

// Requester withdraws every pending query in their own request
router.post('/groups/:groupId/cancel', cancelGroup);

// The reason belongs to the request, so editing it is request-scoped
router.patch('/groups/:groupId/reason', validate(queryRequestReasonSchema), updateReason);

// Lists — static paths before /:id so they aren't swallowed by the param route
router.get('/mine', listMyRequests);
router.get('/pending', listPendingApprovals);
router.get('/pending/count', getPendingCount);
router.get('/reviewed', listReviewed);

router.get('/:id', getRequest);
router.get('/:id/result', getRequestResult);

// Requester amends their own still-pending request
router.patch('/:id', validate(queryRequestUpdateSchema), updateRequest);

// Approve and run, under the approver's own role
router.post('/:id/approve', validate(queryRequestApproveSchema), approveRequest);
router.post('/:id/reject', validate(queryRequestRejectSchema), rejectRequest);

// Requester withdraws their own pending request
router.post('/:id/cancel', cancelRequest);

export default router;

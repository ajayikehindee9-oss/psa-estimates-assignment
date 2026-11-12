'use client';

/**
 * EstimateList
 *
 * Displays all estimates for an account.
 * Handles: loading, empty state, status filtering, status transitions,
 * soft-delete, and opening a detail/edit view inline.
 *
 * Data is fetched client-side via apiFetch so the component can be used
 * inside the existing account page pattern (Server Component renders the
 * shell; this Client Component owns the data lifecycle).
 */

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PlusIcon, MoreHorizontal, FileText, Send, CheckCircle2, XCircle, Trash2 } from 'lucide-react';
import { EstimateCreateDialog } from './estimate-create-dialog';
import { EstimateLineItemEditor, LineItemDraft } from './estimate-line-item-editor';
import { apiFetch } from '@/lib/api-config';
import { formatCents, type EstimateWithLineItems } from '@/lib/supabase';
import { format } from 'date-fns';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EstimateStatus = 'draft' | 'sent' | 'accepted' | 'rejected';

interface ProjectOption {
  id: string;
  name: string;
}

interface Props {
  accountId: string;
  canManage: boolean;
  projects?: ProjectOption[];
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<
  EstimateStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive'; icon: React.ReactNode }
> = {
  draft: { label: 'Draft', variant: 'secondary', icon: <FileText className="h-3 w-3" /> },
  sent: { label: 'Sent', variant: 'default', icon: <Send className="h-3 w-3" /> },
  accepted: { label: 'Accepted', variant: 'outline', icon: <CheckCircle2 className="h-3 w-3" /> },
  rejected: { label: 'Rejected', variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
};

function StatusBadge({ status }: { status: EstimateStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.draft;
  return (
    <Badge variant={cfg.variant} className="flex items-center gap-1 w-fit">
      {cfg.icon}
      {cfg.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Detail panel (inline, read + edit for drafts)
// ---------------------------------------------------------------------------

function EstimateDetail({
  estimate,
  accountId,
  canManage,
  onUpdated,
  onClose,
}: {
  estimate: EstimateWithLineItems;
  accountId: string;
  canManage: boolean;
  onUpdated: (updated: EstimateWithLineItems) => void;
  onClose: () => void;
}) {
  const isDraft = estimate.status === 'draft';
  const [saving, setSaving] = useState(false);

  // Editable line items (only for draft)
  const [lineItems, setLineItems] = useState<LineItemDraft[]>(
    (estimate.line_items ?? []).map((li, idx) => ({
      _key: li.id ?? `li-${idx}`,
      description: li.description,
      quantity: li.quantity,
      unit_price: li.unit_price_cents / 100,
    })),
  );

  const handleSaveLineItems = useCallback(async () => {
    setSaving(true);
    try {
      const res = await apiFetch(
        `/api/accounts/${accountId}/estimates/${estimate.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            line_items: lineItems.map((li, idx) => ({
              description: li.description,
              quantity: li.quantity,
              unit_price: li.unit_price,
              sort_order: idx,
            })),
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error ?? 'Failed to save changes');
        return;
      }
      toast.success('Line items updated');
      onUpdated(data.estimate as EstimateWithLineItems);
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  }, [accountId, estimate.id, lineItems, onUpdated]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">{estimate.title}</h3>
          {estimate.description && (
            <p className="text-muted-foreground mt-0.5 text-sm">{estimate.description}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close detail view">
          ✕
        </Button>
      </div>

      {/* Meta */}
      <div className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <span className="font-medium text-foreground">Status</span>
        <StatusBadge status={estimate.status as EstimateStatus} />
        {estimate.valid_until && (
          <>
            <span className="font-medium text-foreground">Valid until</span>
            <span>{format(new Date(estimate.valid_until), 'MMM d, yyyy')}</span>
          </>
        )}
        {estimate.project && (
          <>
            <span className="font-medium text-foreground">Project</span>
            <span>{estimate.project.name}</span>
          </>
        )}
      </div>

      {/* Line items */}
      <div>
        <p className="mb-2 text-sm font-medium">Line items</p>
        {isDraft && canManage ? (
          <div className="space-y-3">
            <EstimateLineItemEditor
              items={lineItems}
              onChange={setLineItems}
              disabled={saving}
            />
            <Button size="sm" onClick={handleSaveLineItems} disabled={saving}>
              {saving ? 'Saving…' : 'Save line items'}
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(estimate.line_items ?? []).map((li) => (
                <TableRow key={li.id}>
                  <TableCell>{li.description}</TableCell>
                  <TableCell className="text-right tabular-nums">{li.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCents(li.unit_price_cents, estimate.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatCents(li.amount_cents, estimate.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Totals */}
      <div className="border-t pt-3 space-y-1 text-sm">
        <div className="flex justify-end gap-8">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="tabular-nums w-28 text-right">{formatCents(estimate.subtotal_cents, estimate.currency)}</span>
        </div>
        {estimate.tax_cents > 0 && (
          <div className="flex justify-end gap-8">
            <span className="text-muted-foreground">Tax</span>
            <span className="tabular-nums w-28 text-right">{formatCents(estimate.tax_cents, estimate.currency)}</span>
          </div>
        )}
        <div className="flex justify-end gap-8 font-semibold">
          <span>Total</span>
          <span className="tabular-nums w-28 text-right">{formatCents(estimate.total_cents, estimate.currency)}</span>
        </div>
      </div>

      {/* Notes */}
      {estimate.notes && (
        <div className="rounded-md border p-3 text-sm">
          <p className="text-muted-foreground mb-1 font-medium text-xs uppercase tracking-wide">Notes</p>
          <p className="whitespace-pre-line">{estimate.notes}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function EstimateList({ accountId, canManage, projects = [] }: Props) {
  const [estimates, setEstimates] = useState<EstimateWithLineItems[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<EstimateStatus | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Fetch
  // ---------------------------------------------------------------------------

  const fetchEstimates = useCallback(async () => {
    setLoading(true);
    try {
      const params = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
      const res = await apiFetch(`/api/accounts/${accountId}/estimates${params}`);
      const data = await res.json();
      if (res.ok) {
        setEstimates(data.estimates ?? []);
      } else {
        toast.error(data?.error ?? 'Failed to load estimates');
      }
    } catch {
      toast.error('Failed to load estimates');
    } finally {
      setLoading(false);
    }
  }, [accountId, statusFilter]);

  useEffect(() => {
    fetchEstimates();
  }, [fetchEstimates]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleCreated = useCallback((estimate: EstimateWithLineItems) => {
    setEstimates((prev) => [estimate, ...prev]);
    setSelectedId(estimate.id);
  }, []);

  const handleUpdated = useCallback((updated: EstimateWithLineItems) => {
    setEstimates((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e)),
    );
  }, []);

  const handleTransition = useCallback(
    async (estimateId: string, newStatus: EstimateStatus) => {
      setTransitioning(estimateId);
      try {
        const res = await apiFetch(
          `/api/accounts/${accountId}/estimates/${estimateId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus }),
          },
        );
        const data = await res.json();
        if (!res.ok) {
          toast.error(data?.error ?? 'Failed to update status');
          return;
        }
        toast.success(`Estimate marked as ${newStatus}`);
        setEstimates((prev) =>
          prev.map((e) => (e.id === estimateId ? { ...e, status: newStatus } : e)),
        );
        // Close detail panel if open for this estimate
        if (selectedId === estimateId) setSelectedId(null);
      } catch {
        toast.error('Failed to update estimate status');
      } finally {
        setTransitioning(null);
      }
    },
    [accountId, selectedId],
  );

  const handleDelete = useCallback(async () => {
    if (!deletingId) return;
    try {
      const res = await apiFetch(
        `/api/accounts/${accountId}/estimates/${deletingId}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error ?? 'Failed to delete estimate');
        return;
      }
      toast.success('Estimate deleted');
      setEstimates((prev) => prev.filter((e) => e.id !== deletingId));
      if (selectedId === deletingId) setSelectedId(null);
    } catch {
      toast.error('Failed to delete estimate');
    } finally {
      setDeletingId(null);
    }
  }, [accountId, deletingId, selectedId]);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const selectedEstimate = estimates.find((e) => e.id === selectedId) ?? null;

  const tableRows = loading
    ? Array.from({ length: 3 }).map((_, i) => (
        <TableRow key={i}>
          {[1, 2, 3, 4, 5].map((col) => (
            <TableCell key={col}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))
    : estimates.map((estimate) => (
        <TableRow
          key={estimate.id}
          className={`cursor-pointer ${selectedId === estimate.id ? 'bg-muted/60' : ''}`}
          onClick={() => setSelectedId(selectedId === estimate.id ? null : estimate.id)}
          aria-selected={selectedId === estimate.id}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              setSelectedId(selectedId === estimate.id ? null : estimate.id);
            }
          }}
        >
          <TableCell className="font-medium max-w-[200px] truncate">
            {estimate.title}
          </TableCell>
          <TableCell>
            <StatusBadge status={estimate.status as EstimateStatus} />
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {formatCents(estimate.total_cents, estimate.currency)}
          </TableCell>
          <TableCell className="text-muted-foreground text-sm">
            {estimate.valid_until
              ? format(new Date(estimate.valid_until), 'MMM d, yyyy')
              : '—'}
          </TableCell>
          <TableCell className="text-muted-foreground text-sm">
            {format(new Date(estimate.created_at), 'MMM d, yyyy')}
          </TableCell>
          {canManage && (
            <TableCell onClick={(e) => e.stopPropagation()} className="text-right">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Actions for ${estimate.title}`}
                    disabled={transitioning === estimate.id}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {estimate.status === 'draft' && (
                    <DropdownMenuItem
                      onClick={() => handleTransition(estimate.id, 'sent')}
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Mark as sent
                    </DropdownMenuItem>
                  )}
                  {estimate.status === 'sent' && (
                    <>
                      <DropdownMenuItem
                        onClick={() => handleTransition(estimate.id, 'accepted')}
                      >
                        <CheckCircle2 className="mr-2 h-4 w-4" />
                        Mark as accepted
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleTransition(estimate.id, 'rejected')}
                        className="text-destructive focus:text-destructive"
                      >
                        <XCircle className="mr-2 h-4 w-4" />
                        Mark as rejected
                      </DropdownMenuItem>
                    </>
                  )}
                  {estimate.status === 'draft' && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeletingId(estimate.id)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          )}
        </TableRow>
      ));

  return (
    <>
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <CardTitle className="text-lg sm:text-xl">Estimates</CardTitle>
              <CardDescription className="mt-1">
                Draft, send, and track estimates for this account
              </CardDescription>
            </div>

            <div className="flex items-center gap-2">
              {/* Status filter */}
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as EstimateStatus | 'all')}
              >
                <SelectTrigger className="h-8 w-[130px] text-sm" aria-label="Filter by status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="accepted">Accepted</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>

              {canManage && (
                <EstimateCreateDialog
                  accountId={accountId}
                  projects={projects}
                  onCreated={handleCreated}
                >
                  <Button size="sm" className="flex items-center gap-1.5">
                    <PlusIcon className="h-4 w-4" />
                    <span className="hidden sm:inline">New estimate</span>
                    <span className="sm:hidden">New</span>
                  </Button>
                </EstimateCreateDialog>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {!loading && estimates.length === 0 ? (
            <div className="py-10 text-center">
              <FileText className="text-muted-foreground mx-auto mb-3 h-10 w-10" />
              <p className="text-muted-foreground text-sm">
                {statusFilter === 'all'
                  ? 'No estimates yet.'
                  : `No ${statusFilter} estimates.`}
              </p>
              {canManage && statusFilter === 'all' && (
                <EstimateCreateDialog
                  accountId={accountId}
                  projects={projects}
                  onCreated={handleCreated}
                >
                  <Button variant="outline" size="sm" className="mt-4">
                    Create the first estimate
                  </Button>
                </EstimateCreateDialog>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Valid until</TableHead>
                    <TableHead>Created</TableHead>
                    {canManage && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>{tableRows}</TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Inline detail / edit panel */}
      {selectedEstimate && (
        <Card>
          <CardContent className="pt-6">
            <EstimateDetail
              estimate={selectedEstimate}
              accountId={accountId}
              canManage={canManage}
              onUpdated={handleUpdated}
              onClose={() => setSelectedId(null)}
            />
          </CardContent>
        </Card>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deletingId} onOpenChange={(open) => !open && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete estimate?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the draft estimate. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

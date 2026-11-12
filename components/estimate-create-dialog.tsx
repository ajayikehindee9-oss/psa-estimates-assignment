'use client';

/**
 * EstimateCreateDialog
 *
 * A Dialog that lets users create a draft estimate with line items.
 * Accepts a trigger child (renders it as the dialog trigger).
 * Calls onCreated with the new estimate when successfully submitted.
 */

import { useState, useCallback, useId } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EstimateLineItemEditor, LineItemDraft, newLineItem } from './estimate-line-item-editor';
import { apiFetch } from '@/lib/api-config';
import type { EstimateWithLineItems } from '@/lib/supabase';

interface ProjectOption {
  id: string;
  name: string;
}

interface Props {
  accountId: string;
  projects?: ProjectOption[];
  onCreated: (estimate: EstimateWithLineItems) => void;
  children: React.ReactNode;
}

function generateIdempotencyKey(): string {
  // Simple RFC4122-like v4 UUID for idempotency
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function EstimateCreateDialog({ accountId, projects = [], onCreated, children }: Props) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState<string>('');
  const [validUntil, setValidUntil] = useState('');
  const [taxRate, setTaxRate] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [lineItems, setLineItems] = useState<LineItemDraft[]>([newLineItem()]);

  const reset = useCallback(() => {
    setTitle('');
    setDescription('');
    setProjectId('');
    setValidUntil('');
    setTaxRate(0);
    setNotes('');
    setLineItems([newLineItem()]);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      setOpen(next);
    },
    [reset],
  );

  // Computed totals (display only — server recomputes authoritatively)
  const subtotal = lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0);
  const tax = Math.round(subtotal * (taxRate / 100) * 100) / 100;
  const total = subtotal + tax;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!title.trim()) {
        toast.error('Title is required');
        return;
      }
      if (lineItems.length === 0) {
        toast.error('At least one line item is required');
        return;
      }
      const invalidItem = lineItems.find(
        (li) => !li.description.trim() || li.quantity <= 0,
      );
      if (invalidItem) {
        toast.error('Every line item needs a description and a positive quantity');
        return;
      }

      setSubmitting(true);
      try {
        const body = {
          title: title.trim(),
          description: description.trim() || undefined,
          project_id: projectId || undefined,
          valid_until: validUntil || undefined,
          tax_rate: taxRate || undefined,
          notes: notes.trim() || undefined,
          line_items: lineItems.map((li, idx) => ({
            description: li.description.trim(),
            quantity: li.quantity,
            unit_price: li.unit_price,
            sort_order: idx,
          })),
        };

        const idempotencyKey = generateIdempotencyKey();

        const res = await apiFetch(`/api/accounts/${accountId}/estimates`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        });

        const data = await res.json();

        if (!res.ok) {
          toast.error(data?.error ?? 'Failed to create estimate');
          return;
        }

        toast.success('Estimate created');
        onCreated(data.estimate as EstimateWithLineItems);
        setOpen(false);
        reset();
      } catch {
        toast.error('An unexpected error occurred');
      } finally {
        setSubmitting(false);
      }
    },
    [title, description, projectId, validUntil, taxRate, notes, lineItems, accountId, onCreated, reset],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>

      <DialogContent
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto"
        aria-labelledby={`${uid}-title`}
      >
        <DialogHeader>
          <DialogTitle id={`${uid}-title`}>New estimate</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-title-input`}>
              Title <span aria-hidden="true" className="text-destructive">*</span>
            </Label>
            <Input
              id={`${uid}-title-input`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Website redesign — Phase 1"
              disabled={submitting}
              required
              aria-required="true"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-description`}>Description</Label>
            <Textarea
              id={`${uid}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional summary for the client"
              rows={2}
              disabled={submitting}
            />
          </div>

          {/* Project + Valid until — side by side */}
          <div className="grid gap-4 sm:grid-cols-2">
            {projects.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-project`}>Linked project</Label>
                <Select
                  value={projectId}
                  onValueChange={setProjectId}
                  disabled={submitting}
                >
                  <SelectTrigger id={`${uid}-project`}>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-valid-until`}>Valid until</Label>
              <Input
                id={`${uid}-valid-until`}
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>

          {/* Line items */}
          <div className="space-y-1.5">
            <Label>
              Line items <span aria-hidden="true" className="text-destructive">*</span>
            </Label>
            <EstimateLineItemEditor
              items={lineItems}
              onChange={setLineItems}
              disabled={submitting}
            />
          </div>

          {/* Tax rate + totals */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-tax`}>Tax rate (%)</Label>
              <Input
                id={`${uid}-tax`}
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={taxRate}
                onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)}
                disabled={submitting}
                className="w-32"
              />
            </div>

            {/* Summary */}
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular-nums">${subtotal.toFixed(2)}</span>
              </div>
              {taxRate > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tax ({taxRate}%)</span>
                  <span className="tabular-nums">${tax.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold">
                <span>Total</span>
                <span className="tabular-nums">${total.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-notes`}>Notes</Label>
            <Textarea
              id={`${uid}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Payment terms, scope exclusions, etc."
              rows={3}
              disabled={submitting}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create estimate'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

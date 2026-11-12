'use client';

/**
 * EstimateLineItemEditor
 *
 * A controlled component that manages an ordered list of line items.
 * All monetary values are handled as plain decimal numbers (e.g. 99.99)
 * in the UI; conversion to cents happens at the API boundary.
 */

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Trash2, PlusCircle, GripVertical } from 'lucide-react';

export interface LineItemDraft {
  /** client-only stable key for React reconciliation */
  _key: string;
  description: string;
  quantity: number;
  unit_price: number;
}

interface Props {
  items: LineItemDraft[];
  onChange: (items: LineItemDraft[]) => void;
  disabled?: boolean;
}

let _keyCounter = 0;
export function newLineItem(): LineItemDraft {
  return { _key: `li-${++_keyCounter}`, description: '', quantity: 1, unit_price: 0 };
}

function lineTotal(item: LineItemDraft): number {
  return Math.round(item.quantity * item.unit_price * 100) / 100;
}

export function EstimateLineItemEditor({ items, onChange, disabled = false }: Props) {
  const update = useCallback(
    (index: number, patch: Partial<LineItemDraft>) => {
      const next = items.map((item, i) => (i === index ? { ...item, ...patch } : item));
      onChange(next);
    },
    [items, onChange],
  );

  const remove = useCallback(
    (index: number) => {
      onChange(items.filter((_, i) => i !== index));
    },
    [items, onChange],
  );

  const add = useCallback(() => {
    onChange([...items, newLineItem()]);
  }, [items, onChange]);

  const subtotal = items.reduce((sum, li) => sum + lineTotal(li), 0);

  return (
    <div className="space-y-3">
      {/* Column headers */}
      <div
        className="grid text-muted-foreground hidden sm:grid text-xs font-medium px-1"
        style={{ gridTemplateColumns: '1.5rem 1fr 7rem 9rem 7rem 2.5rem' }}
        aria-hidden="true"
      >
        <span />
        <span>Description</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Unit price</span>
        <span className="text-right">Amount</span>
        <span />
      </div>

      {items.length === 0 && (
        <p className="text-muted-foreground py-4 text-center text-sm">
          No line items yet. Add one below.
        </p>
      )}

      {/* Line item rows */}
      <ul className="space-y-2" aria-label="Line items">
        {items.map((item, idx) => (
          <li
            key={item._key}
            className="bg-muted/40 grid items-center gap-2 rounded-md border p-2"
            style={{ gridTemplateColumns: '1.5rem 1fr 7rem 9rem 7rem 2.5rem' }}
          >
            {/* Drag handle (visual only — drag-to-reorder is out of scope) */}
            <span
              className="text-muted-foreground flex cursor-default items-center justify-center"
              aria-hidden="true"
            >
              <GripVertical className="h-4 w-4" />
            </span>

            {/* Description */}
            <div>
              <Label htmlFor={`li-desc-${item._key}`} className="sr-only">
                Description for line item {idx + 1}
              </Label>
              <Input
                id={`li-desc-${item._key}`}
                value={item.description}
                onChange={(e) => update(idx, { description: e.target.value })}
                placeholder="Description"
                disabled={disabled}
                className="h-8 text-sm"
                aria-required="true"
              />
            </div>

            {/* Quantity */}
            <div>
              <Label htmlFor={`li-qty-${item._key}`} className="sr-only">
                Quantity for line item {idx + 1}
              </Label>
              <Input
                id={`li-qty-${item._key}`}
                type="number"
                min={0.0001}
                step="any"
                value={item.quantity}
                onChange={(e) => update(idx, { quantity: parseFloat(e.target.value) || 0 })}
                disabled={disabled}
                className="h-8 text-right text-sm"
                aria-label={`Quantity for line item ${idx + 1}`}
              />
            </div>

            {/* Unit price */}
            <div className="relative">
              <span className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm select-none">
                $
              </span>
              <Label htmlFor={`li-price-${item._key}`} className="sr-only">
                Unit price for line item {idx + 1}
              </Label>
              <Input
                id={`li-price-${item._key}`}
                type="number"
                min={0}
                step="0.01"
                value={item.unit_price}
                onChange={(e) => update(idx, { unit_price: parseFloat(e.target.value) || 0 })}
                disabled={disabled}
                className="h-8 pl-6 text-right text-sm"
                aria-label={`Unit price for line item ${idx + 1}`}
              />
            </div>

            {/* Amount (read-only computed) */}
            <div
              className="text-foreground pr-1 text-right text-sm font-medium tabular-nums"
              aria-label={`Amount for line item ${idx + 1}: $${lineTotal(item).toFixed(2)}`}
            >
              ${lineTotal(item).toFixed(2)}
            </div>

            {/* Remove */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-destructive hover:text-destructive h-8 w-8"
              onClick={() => remove(idx)}
              disabled={disabled}
              aria-label={`Remove line item ${idx + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>

      {/* Add row */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={add}
        disabled={disabled}
        className="flex items-center gap-2"
      >
        <PlusCircle className="h-4 w-4" />
        Add line item
      </Button>

      {/* Subtotal */}
      {items.length > 0 && (
        <div className="border-t pt-3">
          <div className="flex justify-end">
            <span className="text-muted-foreground pr-4 text-sm">Subtotal</span>
            <span className="text-foreground w-28 text-right text-sm font-semibold tabular-nums">
              ${subtotal.toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

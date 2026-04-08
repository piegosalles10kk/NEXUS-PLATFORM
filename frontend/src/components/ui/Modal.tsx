import { ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Max width class, defaults to max-w-lg */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Footer content (action buttons) */
  footer?: ReactNode;
}

const sizes = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
};

export function Modal({ open, onClose, title, description, children, size = 'md', footer }: ModalProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={`relative w-full ${sizes[size]} glass-elevated animate-scale-in`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-5 border-b border-white/[0.06]">
          <div>
            <h2 className="text-base font-semibold text-text-primary leading-snug">{title}</h2>
            {description && (
              <p className="text-[13px] text-text-secondary mt-1">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/[0.05] transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-3 px-6 pb-6 pt-1">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Reusable button styles for modal footers */
export function ModalCancelButton({ onClick, label = 'Cancelar' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.05] transition-colors"
    >
      {label}
    </button>
  );
}

export function ModalSubmitButton({
  label = 'Confirmar',
  loading = false,
  disabled = false,
  form,
}: {
  label?: string;
  loading?: boolean;
  disabled?: boolean;
  form?: string;
}) {
  return (
    <button
      type="submit"
      form={form}
      disabled={loading || disabled}
      className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      {loading ? 'Aguarde…' : label}
    </button>
  );
}

import { Button as SdkButton } from '@ui-sdk/react/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@ui-sdk/react/field'
import { Input } from '@ui-sdk/react/input'
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from '@ui-sdk/react/segmented-control'
import type { ComponentProps, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  ...props
}: ComponentProps<typeof SdkButton> & { variant?: ButtonVariant }) {
  return <SdkButton data-variant={variant} {...props} />
}

export function WordAction(props: ComponentProps<'a'>) {
  return <a data-ansi="word-action" {...props} />
}

export function TextField({
  label,
  description,
  error,
  ...input
}: ComponentProps<typeof Input> & { label: string; description?: ReactNode; error?: ReactNode }) {
  return (
    <Field data-ansi="field" invalid={error !== undefined ? true : undefined}>
      <FieldLabel>{label}</FieldLabel>
      <Input {...input} />
      <div data-ansi="field-messages">
        <FieldDescription data-shown={error === undefined ? '' : undefined}>
          {description ?? ' '}
        </FieldDescription>
        <FieldError
          match={error !== undefined ? true : undefined}
          data-shown={error !== undefined ? '' : undefined}
        >
          {error ?? ' '}
        </FieldError>
        <span data-ansi="field-sizer" aria-hidden="true">
          {error ?? description ?? ' '}
        </span>
      </div>
    </Field>
  )
}

export function Choice<V extends string>({
  label,
  options,
  value,
  onValueChange,
}: {
  label: string
  options: readonly { value: V; label: string }[]
  value: V
  onValueChange: (value: V) => void
}) {
  return (
    <SegmentedControl
      aria-label={label}
      value={value}
      onValueChange={(next) => onValueChange(next as V)}
    >
      <SegmentedControlIndicator />
      {options.map((o) => (
        <SegmentedControlItem key={o.value} value={o.value}>
          {o.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  )
}

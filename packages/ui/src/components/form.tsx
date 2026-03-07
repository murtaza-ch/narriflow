"use client"

import * as React from "react"
import { Field } from "@chakra-ui/react"
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form"

const Form = FormProvider

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
  name: TName
}

const FormFieldContext = React.createContext<FormFieldContextValue>(
  {} as FormFieldContextValue,
)

const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  ...props
}: ControllerProps<TFieldValues, TName>) => {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  )
}

const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext)
  const itemContext = React.useContext(FormItemContext)
  const { getFieldState } = useFormContext()
  const formState = useFormState({ name: fieldContext.name })
  const fieldState = getFieldState(fieldContext.name, formState)

  if (!fieldContext) {
    throw new Error("useFormField should be used within <FormField>")
  }

  const { id } = itemContext

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  }
}

type FormItemContextValue = {
  id: string
}

const FormItemContext = React.createContext<FormItemContextValue>(
  {} as FormItemContextValue,
)

function FormItem({
  children,
  ...props
}: React.ComponentProps<typeof Field.Root>) {
  const id = React.useId()

  return (
    <FormItemContext.Provider value={{ id }}>
      <Field.Root {...props}>{children}</Field.Root>
    </FormItemContext.Provider>
  )
}

function FormLabel(props: React.ComponentProps<typeof Field.Label>) {
  const { error, formItemId } = useFormField()

  return (
    <Field.Label
      htmlFor={formItemId}
      color={error ? "red.500" : undefined}
      {...props}
    />
  )
}

function FormControl({ children }: { children: React.ReactNode }) {
  const { error, formItemId, formDescriptionId, formMessageId } =
    useFormField()

  return (
    <>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child
        return React.cloneElement(
          child as React.ReactElement<Record<string, unknown>>,
          {
            id: formItemId,
            "aria-describedby": !error
              ? formDescriptionId
              : `${formDescriptionId} ${formMessageId}`,
            "aria-invalid": !!error,
          },
        )
      })}
    </>
  )
}

function FormDescription(props: React.ComponentProps<typeof Field.HelperText>) {
  const { formDescriptionId } = useFormField()

  return <Field.HelperText id={formDescriptionId} {...props} />
}

function FormMessage({
  children,
  ...props
}: React.ComponentProps<typeof Field.ErrorText>) {
  const { error, formMessageId } = useFormField()
  const body = error ? String(error?.message ?? "") : children

  if (!body) {
    return null
  }

  return (
    <Field.ErrorText id={formMessageId} {...props}>
      {body}
    </Field.ErrorText>
  )
}

export {
  useFormField,
  Form,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  FormField,
}

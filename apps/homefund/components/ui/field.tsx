"use client";

import {
  cloneElement,
  createContext,
  useContext,
  useId,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { Flex, Text } from "@radix-ui/themes";

import type { MessageKey } from "@/lib/use-action-toast";

// Carries a Field's invalid flag and error id down to its label and control.
const FieldContext = createContext({ invalid: false, errorId: "" });

// One vertical stack of Fields, the gap that separates one form row from the next.
export function FieldGroup({ children }: { children?: ReactNode }) {
  return (
    <Flex direction="column" gap="5" width="100%">
      {children}
    </Flex>
  );
}

// One form row: label, control, description and error stacked together.
export function Field({
  invalid,
  children,
}: {
  invalid?: boolean;
  children?: ReactNode;
}) {
  const errorId = useId();
  const value = useMemo(
    () => ({ invalid: !!invalid, errorId }),
    [invalid, errorId],
  );

  return (
    <FieldContext.Provider value={value}>
      <Flex
        role="group"
        direction="column"
        gap="2"
        width="100%"
        data-invalid={invalid || undefined}
      >
        {children}
      </Flex>
    </FieldContext.Provider>
  );
}

// `aria-invalid` and `aria-describedby` for the control a Field wraps, both
// unset while the field is valid.
function useFieldControl() {
  const { invalid, errorId } = useContext(FieldContext);
  return {
    "aria-invalid": invalid ? true : undefined,
    "aria-describedby": invalid ? errorId : undefined,
  };
}

// Puts those attributes on the control it wraps. A wrapper, not a hook the
// screen calls: the scope that renders `<Field>` sits above the context Field
// provides, so reading it there yields the ambient value and both attributes
// come back undefined.
export function FieldControl({ children }: { children: ReactElement }) {
  return cloneElement(children, useFieldControl());
}

export function FieldLabel({
  htmlFor,
  id,
  children,
}: {
  htmlFor?: string;
  id?: string;
  children?: ReactNode;
}) {
  const { invalid } = useContext(FieldContext);

  if (htmlFor) {
    return (
      <Text
        as="label"
        htmlFor={htmlFor}
        size="2"
        weight="medium"
        color={invalid ? "red" : undefined}
      >
        {children}
      </Text>
    );
  }

  // Not labelable: a `<div role="radiogroup">` or `<fieldset>` names itself
  // through `aria-labelledby` pointing at this span's `id` instead.
  return (
    <Text
      as="span"
      id={id}
      size="2"
      weight="medium"
      color={invalid ? "red" : undefined}
    >
      {children}
    </Text>
  );
}

export function FieldDescription({ children }: { children?: ReactNode }) {
  return (
    <Text as="p" size="2" color="gray">
      {children}
    </Text>
  );
}

export function FieldError({
  id,
  errors,
  children,
}: {
  id?: string;
  errors?: Array<{ message?: string } | undefined>;
  children?: ReactNode;
}) {
  const content = useMemo(() => {
    if (children) {
      return children;
    }

    if (!errors?.length) {
      return null;
    }

    // Same message reported twice (e.g. by two rules) collapses to one.
    const uniqueErrors = [
      ...new Map(errors.map((error) => [error?.message, error])).values(),
    ];

    if (uniqueErrors.length === 1) {
      return uniqueErrors[0]?.message;
    }

    return (
      <ul>
        {uniqueErrors.map(
          (error, index) =>
            error?.message && <li key={index}>{error.message}</li>,
        )}
      </ul>
    );
  }, [children, errors]);

  if (!content) {
    return null;
  }

  return (
    <Text id={id} as="div" role="alert" size="2" color="red">
      {content}
    </Text>
  );
}

// One node of what React Hook Form stores under a field: a leaf carries the
// message, an array field carries `root` or the elements that broke instead.
type FieldErrorTree = {
  message?: string;
  root?: FieldErrorTree;
  [key: string]: unknown;
};

// The first catalogue path the tree holds. An array field such as `splits` keeps
// no message of its own: the empty-category error sits at `splits.0.categoryId`,
// and a field that reports nothing tells the person nothing.
function firstMessage(error: FieldErrorTree): string | undefined {
  if (error.message) {
    return error.message;
  }

  if (error.root) {
    const rootMessage = firstMessage(error.root);
    if (rootMessage) return rootMessage;
  }

  for (const [key, value] of Object.entries(error)) {
    // `ref` holds the control itself, not an error.
    if (key === "ref" || key === "root" || !value || typeof value !== "object") {
      continue;
    }

    const nested = firstMessage(value as FieldErrorTree);
    if (nested) return nested;
  }

  return undefined;
}

// React Hook Form carries the catalogue path, not the sentence: the message is
// translated here, under the Field's error id.
export function FieldMessage({ error }: { error?: FieldErrorTree }) {
  const { errorId } = useContext(FieldContext);
  const t = useTranslations();

  const message = error && firstMessage(error);

  if (!message) {
    return null;
  }

  return (
    <FieldError id={errorId} errors={[{ message: t(message as MessageKey) }]} />
  );
}

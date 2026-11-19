import '@mantine/dates/styles.css';
import { useLayoutEffect } from 'react';
import { Button, Container, Group } from '@mantine/core';
import { reportHeight } from './fit.ts';
import RjsfForm from '@rjsf/mantine';
import { validator } from './validator.ts';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { types } from '@cmdless/ui-sdk';

const close = (value?: unknown) => window.cmdless.view.notify.close({ value });

// a JSON Schema form: submitting ends the window with the data, once it's
// valid; Cancel (or Escape) ends it with nothing
export default function Form({ schema, uiSchema, formData, submitText }: types.FormView) {
  useLayoutEffect(reportHeight, []);
  return (
    <Container size="sm" py="md" onKeyDown={event => event.key === 'Escape' && close()}>
      <RjsfForm
        schema={schema as RJSFSchema}
        uiSchema={uiSchema as UiSchema}
        formData={formData}
        validator={validator}
        showErrorList={false}
        onSubmit={({ formData }) => close(formData)}
      >
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => close()}>Cancel</Button>
          <Button type="submit">{submitText ?? 'Submit'}</Button>
        </Group>
      </RjsfForm>
    </Container>
  );
}

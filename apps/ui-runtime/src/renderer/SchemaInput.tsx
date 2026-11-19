import * as AC from 'adaptivecards';
import { useLayoutEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import RjsfForm from '@rjsf/mantine';
import type Form from '@rjsf/core';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { validator } from './validator.ts';
import { reportHeight } from './fit.ts';

// the form draws after the card it's in, so it says when it has
function Drawn({ children }: { children: ReactNode }) {
  useLayoutEffect(reportHeight, []);
  return children;
}

// an input for a card whose body is a JSON Schema form: "Input.JsonSchema",
// with the schema, an optional uiSchema, and its starting value. Its value is
// the form's data - an object, not a string - and a Submit tied to it (any,
// unless it says associatedInputs: "none") waits until the form is valid,
// showing what isn't under each field.
export class SchemaInput extends AC.Input {
  static readonly typeName = 'Input.JsonSchema';

  private schema: RJSFSchema = { type: 'object' };
  private uiSchema?: UiSchema;
  private data: unknown;
  private form?: Form | null;

  getJsonTypeName() {
    return SchemaInput.typeName;
  }

  // schema, uiSchema and value are taken as they are: they're JSON
  // themselves, not card properties
  protected override internalParse(source: AC.PropertyBag, context: AC.SerializationContext) {
    super.internalParse(source, context);
    if (source.schema && typeof source.schema === 'object') this.schema = source.schema as RJSFSchema;
    if (source.uiSchema && typeof source.uiSchema === 'object') this.uiSchema = source.uiSchema as UiSchema;
    this.data = source.value;
  }

  protected internalRender() {
    const element = document.createElement('div');
    element.className = 'ac-jsonSchemaInput';
    createRoot(element).render(
      <MantineProvider defaultColorScheme="auto">
        <Drawn>
          <RjsfForm
            ref={(form) => {
              this.form = form;
            }}
            schema={this.schema}
            uiSchema={this.uiSchema}
            formData={this.data}
            validator={validator}
            showErrorList={false}
            onChange={({ formData }) => {
              this.data = formData;
              this.valueChanged();
            }}
          >
            {/* no buttons of its own: the card's actions submit it */}
            <></>
          </RjsfForm>
        </Drawn>
      </MantineProvider>,
    );
    return element;
  }

  get value() {
    return this.data;
  }

  isSet() {
    return this.data !== undefined;
  }

  // validates through the form, so its errors show under its fields
  override isValid() {
    if (this.form) return this.form.validateForm();
    return Object.keys(validator.validateFormData(this.data, this.schema).errorSchema).length === 0;
  }
}

AC.GlobalRegistry.elements.register(SchemaInput.typeName, SchemaInput);

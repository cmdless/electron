import { Validator, type OutputUnit, type Schema, type SchemaDraft } from '@cfworker/json-schema';
import {
  createErrorHandler, getDefaultFormState, toErrorSchema, unwrapErrorHandler, validationDataMerge,
  type CustomValidator, type ErrorTransformer, type RJSFSchema, type RJSFValidationError, type UiSchema,
  type ValidationData, type ValidatorType,
} from '@rjsf/utils';

// react-jsonschema-form's validator, on @cfworker/json-schema rather than
// ajv: it interprets a schema instead of compiling it into code, so the page
// needs no 'unsafe-eval'

// the draft a schema says it's written to - draft-07 if it doesn't say
function draftOf(schema: RJSFSchema): SchemaDraft {
  const declared = schema.$schema ?? '';
  if (declared.includes('2020-12')) return '2020-12';
  if (declared.includes('2019-09')) return '2019-09';
  if (declared.includes('draft-04')) return '4';
  return '7';
}

// what a JSON pointer ("#/properties/user/minLength") points at in a schema
function at(schema: unknown, pointer: string): unknown {
  return pointer.replace(/^#\/?/, '').split('/').filter(Boolean)
    .map(part => decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], schema);
}

// errors that only say something under them failed - the failure itself is
// reported on its own
const WRAPPERS = new Set(['properties', 'items', 'prefixItems', 'additionalItems', 'allOf', '$ref', '$recursiveRef', 'dependentSchemas', 'dependencies', 'patternProperties', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'if', 'then', 'else', 'propertyNames']);

// a short message, in the words rjsf's own validator uses
function messageFor(unit: OutputUnit, schema: RJSFSchema) {
  const value = at(schema, unit.keywordLocation);
  switch (unit.keyword) {
    case 'required': return 'is a required property';
    case 'minLength': return `must NOT have fewer than ${value} characters`;
    case 'maxLength': return `must NOT have more than ${value} characters`;
    case 'minimum': return `must be >= ${value}`;
    case 'maximum': return `must be <= ${value}`;
    case 'exclusiveMinimum': return `must be > ${value}`;
    case 'exclusiveMaximum': return `must be < ${value}`;
    case 'multipleOf': return `must be multiple of ${value}`;
    case 'minItems': return `must NOT have fewer than ${value} items`;
    case 'maxItems': return `must NOT have more than ${value} items`;
    case 'uniqueItems': return 'must NOT have duplicate items';
    case 'pattern': return `must match pattern "${value}"`;
    case 'format': return `must match format "${value}"`;
    case 'type': return `must be ${Array.isArray(value) ? value.join(',') : value}`;
    case 'enum': return 'must be equal to one of the allowed values';
    case 'const': return 'must be equal to constant';
    default: return unit.error.replace(/^Instance /, '').replace(/\.$/, '');
  }
}

// cfworker's errors as rjsf's: where in the data each one is (".a.b"), and
// a message for it
function toRJSFErrors(units: OutputUnit[], schema: RJSFSchema): RJSFValidationError[] {
  const seen = new Set<string>();
  return units.filter(unit => !WRAPPERS.has(unit.keyword)).flatMap(unit => {
    let property = unit.instanceLocation.replace(/^#/, '').split('/').filter(Boolean)
      .map(part => `.${decodeURIComponent(part)}`).join('');
    if (unit.keyword === 'required') {
      const missing = /property "(.*)"/.exec(unit.error)?.[1];
      if (missing) property += `.${missing}`;
    }
    const message = messageFor(unit, schema);
    const key = `${property} ${message}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name: unit.keyword, property, message, stack: key.trim(), schemaPath: unit.keywordLocation }];
  });
}

// a sub-schema with the root's definitions beside it, so its "#/..." refs
// still resolve when it's validated on its own
const withRootDefinitions = (schema: RJSFSchema, rootSchema: RJSFSchema): RJSFSchema =>
  schema === rootSchema ? schema : { ...schema, definitions: rootSchema.definitions, $defs: rootSchema.$defs };

function validate(schema: RJSFSchema, formData: unknown) {
  // cfworker marks up the schema it's given, so it gets a copy
  const validator = new Validator(structuredClone(schema) as Schema, draftOf(schema), false);
  return validator.validate(formData);
}

export const validator: ValidatorType = {
  rawValidation<Result = unknown>(schema: RJSFSchema, formData?: unknown) {
    try {
      return { errors: validate(schema, formData).errors as Result[] };
    } catch (error) {
      return { validationError: error as Error };
    }
  },

  isValid(schema: RJSFSchema, formData: unknown, rootSchema: RJSFSchema) {
    try {
      return validate(withRootDefinitions(schema, rootSchema), formData).valid;
    } catch {
      return false;
    }
  },

  validateFormData(formData: unknown, schema: RJSFSchema, customValidate?: CustomValidator, transformErrors?: ErrorTransformer, uiSchema?: UiSchema): ValidationData<unknown> {
    const { errors: units = [], validationError } = this.rawValidation<OutputUnit>(schema, formData);
    let errors = toRJSFErrors(units, schema);
    if (validationError) errors.push({ stack: validationError.message });
    if (transformErrors) errors = transformErrors(errors, uiSchema);

    let errorSchema = toErrorSchema(errors);
    if (validationError) errorSchema = { ...errorSchema, $schema: { __errors: [validationError.message] } } as unknown as typeof errorSchema;
    if (!customValidate) return { errors, errorSchema };

    const data = getDefaultFormState(this, schema, formData, schema, true);
    const handler = customValidate(data, createErrorHandler(data), uiSchema, errorSchema);
    return validationDataMerge({ errors, errorSchema }, unwrapErrorHandler(handler));
  },
};

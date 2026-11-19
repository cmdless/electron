// stands in for @rjsf/validator-ajv8, which @rjsf/core imports only for its
// test helper (getTestRegistry) - forms use ./validator.ts, and ajv (which
// needs eval) stays out of the bundle
export default undefined;
export const customizeValidator = () => { throw new Error('ajv is not bundled - use ./validator.ts'); };

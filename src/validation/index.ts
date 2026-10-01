/**
 * Validation rules (`jsails/validation`).
 *
 * Composable, value-free Zod-backed validation rules and a bulk validation
 * helper. Messages never echo input values.
 */

export {
  confirmed,
  email,
  inList,
  max,
  maxLength,
  min,
  minLength,
  regex,
  required,
  url,
  validateFields,
  when,
  type FieldError,
  type ValidationRule,
} from './rules.js';

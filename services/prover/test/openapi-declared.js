// What openapi.js declares, asked of a response the service really sent.
//
// square#254: the spec and the service had drifted apart, in the direction a
// generated client finds out about in production. One statement of "declared"
// lives here and is applied wherever a status is seen, including the suites that
// need real artifacts, because a 200 or a 503 from /prove only exists while a
// real proof is in flight.

import { expect } from 'vitest';
import { openapiSpec } from '../src/openapi.js';

const REF = '#/components/schemas/';

function resolve(schema) {
  return schema?.$ref ? openapiSpec.components.schemas[schema.$ref.slice(REF.length)] : schema;
}

// The status is declared for this method and path, and so is the media type it
// was sent as. Returns the declared schema for the body.
export function expectDeclared(method, route, response) {
  const operation = openapiSpec.paths[route]?.[method.toLowerCase()];
  expect(operation, `${method} ${route} is not in openapi.js`).toBeDefined();
  const declared = operation.responses[String(response.status)];
  expect(declared, `${method} ${route} answered ${response.status}, which openapi.js does not declare`).toBeDefined();
  const sent = String(response.headers['content-type'] ?? '').split(';')[0].trim();
  expect(Object.keys(declared.content ?? {}), `${method} ${route} ${response.status} was sent as ${sent}`).toContain(sent);
  return resolve(declared.content[sent].schema);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

// Every way a value departs from a schema, as a list; empty when it matches.
// Enough of OpenAPI for what this service returns: type, enum, required,
// properties and additionalProperties, following $ref.
export function schemaProblems(value, schemaOrRef, at = '$') {
  const schema = resolve(schemaOrRef);
  if (schema === undefined) return [`${at}: no schema`];
  const problems = [];
  const actual = typeOf(value);
  if (schema.type && !(actual === schema.type || (schema.type === 'number' && actual === 'integer'))) {
    problems.push(`${at}: is ${actual}, declared ${schema.type}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (schema.type === 'object' && actual === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${at}.${key}: declared required, not sent`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        problems.push(...schemaProblems(child, schema.properties[key], `${at}.${key}`));
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        problems.push(...schemaProblems(child, schema.additionalProperties, `${at}.${key}`));
      } else {
        problems.push(`${at}.${key}: sent, not declared`);
      }
    }
  }
  return problems;
}

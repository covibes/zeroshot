/**
 * TemplateResolver - Resolves parameterized cluster templates
 *
 * Takes a base template with {{param}} placeholders and resolves them
 * with provided parameter values. Pure data transformation, no magic.
 *
 * Resolution rules:
 * 1. Load base template JSON
 * 2. Deep clone
 * 3. Walk all values, replace {{param}} with params[param]
 * 4. Handle conditional agents via "condition" field
 * 5. Fail hard if any {{param}} remains unresolved
 */

const fs = require('fs');
const path = require('path');

const COMPARISON_OPERATORS = ['==', '!=', '<=', '>=', '<', '>'];
const TEMPLATE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function invalidTemplateNameError(label, name) {
  return new Error(
    `Invalid ${label} name ${JSON.stringify(name)}: use only letters, numbers, hyphens, and underscores`
  );
}

function resolveNamedTemplatePath(directory, name, label) {
  if (typeof name !== 'string' || !TEMPLATE_NAME_PATTERN.test(name)) {
    throw invalidTemplateNameError(label, name);
  }

  const templateRoot = path.resolve(directory);
  const templatePath = path.resolve(templateRoot, `${name}.json`);
  const relativePath = path.relative(templateRoot, templatePath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw invalidTemplateNameError(label, name);
  }

  return templatePath;
}

function isIdentifierChar(char) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function replaceBareIdentifier(source, name, replacement) {
  let result = '';
  let cursor = 0;

  while (cursor < source.length) {
    const index = source.indexOf(name, cursor);
    if (index === -1) {
      return result + source.slice(cursor);
    }

    const before = source[index - 1];
    const after = source[index + name.length];
    const replace = !isIdentifierChar(before) && !isIdentifierChar(after);
    result += source.slice(cursor, index);
    result += replace ? replacement : name;
    cursor = index + name.length;
  }

  return result;
}

function formatConditionValue(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function parseNumberLiteral(value) {
  if (!value) return null;
  const unsigned = value[0] === '-' ? value.slice(1) : value;
  const parts = unsigned.split('.');
  if (parts.length > 2 || parts.some((part) => part.length === 0)) return null;
  const numeric = parts.every((part) =>
    [...part].every((char) => {
      const code = char.charCodeAt(0);
      return code >= 48 && code <= 57;
    })
  );
  return numeric ? Number(value) : null;
}

function compareValues(left, operator, right) {
  switch (operator) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return left < right;
    case '>':
      return left > right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
    default:
      throw new Error(`Unsupported comparison operator: ${operator}`);
  }
}

class TemplateResolver {
  /**
   * @param {string} templatesDir
   */
  constructor(templatesDir) {
    this.templatesDir = templatesDir;
    this.baseTemplatesDir = path.join(templatesDir, 'base-templates');
  }

  /**
   * Load a static or parameterized cluster config from a safe named reference.
   * Names are identifiers, never filesystem paths.
   *
   * @param {string | {base: string, params?: Object}} config
   * @returns {{kind: 'static' | 'parameterized', name: string, params: Object | null, loadedConfig: Object}}
   */
  resolveConfigReference(config) {
    if (typeof config === 'string') {
      const configPath = resolveNamedTemplatePath(this.templatesDir, config, 'config');
      if (!fs.existsSync(configPath)) {
        throw new Error(`Config not found: ${config} (looked in ${configPath})`);
      }

      return {
        kind: 'static',
        name: config,
        params: null,
        loadedConfig: JSON.parse(fs.readFileSync(configPath, 'utf8')),
      };
    }

    if (
      config &&
      typeof config === 'object' &&
      !Array.isArray(config) &&
      Object.prototype.hasOwnProperty.call(config, 'base')
    ) {
      const { base, params } = config;
      const resolvedParams = params || {};
      return {
        kind: 'parameterized',
        name: base,
        params: resolvedParams,
        loadedConfig: this.resolve(base, resolvedParams),
      };
    }

    throw new Error(
      `Invalid config format: expected string or {base, params}, got ${typeof config}`
    );
  }

  /**
   * Resolve a template with parameters
   * @param {string} baseName - Name of base template (without .json)
   * @param {Object} params - Parameter values to substitute
   * @returns {Object} Resolved cluster config
   */
  resolve(baseName, params) {
    // Load base template
    const templatePath = resolveNamedTemplatePath(this.baseTemplatesDir, baseName, 'base template');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Base template not found: ${baseName} (looked in ${templatePath})`);
    }

    const templateJson = fs.readFileSync(templatePath, 'utf8');
    const template = JSON.parse(templateJson);

    return this.resolveTemplate(template, params);
  }

  /**
   * Resolve an already-loaded parameterized template object.
   * @param {Object} template
   * @param {Object} params
   * @returns {Object} Resolved cluster config
   */
  resolveTemplate(template, params = {}) {
    // Validate required params
    this._validateParams(template, params);

    // Apply defaults for missing params (e.g., timeout: 0)
    const paramsWithDefaults = this._applyDefaults(template, params);

    // Deep clone and resolve
    const resolved = this._resolveObject(JSON.parse(JSON.stringify(template)), paramsWithDefaults);

    // Filter out conditional agents that don't meet their condition
    if (resolved.agents) {
      resolved.agents = resolved.agents.filter((/** @type {any} */ agent) => {
        if (!agent.condition) return true;
        const conditionMet = this._evaluateCondition(agent.condition, paramsWithDefaults);
        delete agent.condition; // Remove condition field from final output
        return conditionMet;
      });
    }

    // Verify no unresolved placeholders remain
    this._verifyResolved(resolved);

    // Remove params schema from output (it's metadata, not config)
    delete resolved.params;

    return resolved;
  }

  /**
   * Validate that required params are provided
   * @private
   * @param {any} template
   * @param {any} params
   */
  _validateParams(template, params) {
    if (!template.params) return;

    const missing = [];
    for (const [name, schema] of Object.entries(template.params)) {
      if (params[name] === undefined && schema.default === undefined) {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      throw new Error(`Missing required params: ${missing.join(', ')}`);
    }
  }

  /**
   * Apply template defaults for any missing params
   * @private
   * @param {any} template
   * @param {any} params
   * @returns {any} params with defaults applied
   */
  _applyDefaults(template, params) {
    if (!template.params) return params;

    const result = { ...params };
    for (const [name, schema] of Object.entries(template.params)) {
      if (result[name] === undefined && schema.default !== undefined) {
        result[name] = schema.default;
      }
    }
    return result;
  }

  /**
   * Recursively resolve placeholders in an object
   * @private
   * @param {any} obj
   * @param {any} params
   * @returns {any}
   */
  _resolveObject(obj, params) {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'string') {
      return this._resolveString(obj, params);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this._resolveObject(item, params));
    }

    if (typeof obj === 'object') {
      /** @type {any} */
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this._resolveObject(value, params);
      }
      return result;
    }

    return obj;
  }

  /**
   * Resolve placeholders in a string
   * Supports: {{param}} and {{#if condition}}...{{/if}}
   * @private
   * @param {any} str
   * @param {any} params
   * @returns {any}
   */
  _resolveString(str, params) {
    // Handle simple {{param}} substitutions
    let result = str.replace(
      /\{\{(\w+)\}\}/g,
      (/** @type {any} */ _match, /** @type {any} */ paramName) => {
        if (params[paramName] !== undefined) {
          return params[paramName];
        }
        // Return match unchanged if param not found (will be caught by verify)
        return _match;
      }
    );

    // Handle {{#if condition}}...{{/if}} blocks
    result = result.replace(
      /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (/** @type {any} */ _match, /** @type {any} */ condition, /** @type {any} */ content) => {
        const conditionMet = this._evaluateCondition(condition, params);
        return conditionMet ? content : '';
      }
    );

    // Clean up multiple newlines from removed conditionals
    result = result.replace(/\n{3,}/g, '\n\n');

    return result;
  }

  /**
   * Evaluate a simple condition expression
   * Supports: param == 'value', param != 'value', {{param}} >= N
   * @private
   * @param {any} condition
   * @param {any} params
   * @returns {boolean}
   */
  _evaluateCondition(condition, params) {
    // Replace {{param}} with actual values first
    let expr = condition.trim();

    // Replace {{param}} placeholders
    expr = expr.replace(
      /\{\{(\w+)\}\}/g,
      (/** @type {any} */ _match, /** @type {any} */ paramName) => {
        return formatConditionValue(params[paramName]);
      }
    );

    // Replace bare param names
    for (const [name, value] of Object.entries(params)) {
      expr = replaceBareIdentifier(expr, name, formatConditionValue(value));
    }

    try {
      // Parse and evaluate simple comparison expressions without eval
      return this._evaluateSimpleExpression(expr);
    } catch {
      console.error(`Failed to evaluate condition: ${condition} (resolved: ${expr})`);
      return false;
    }
  }

  /**
   * Evaluate simple comparison expressions without eval
   * Supports: ==, !=, <, >, <=, >=, &&, ||
   * @private
   * @param {string} expr
   * @returns {boolean}
   */
  _evaluateSimpleExpression(expr) {
    // Handle logical operators (&&, ||) by splitting and recursing
    if (expr.includes('||')) {
      return expr.split('||').some((part) => this._evaluateSimpleExpression(part.trim()));
    }
    if (expr.includes('&&')) {
      return expr.split('&&').every((part) => this._evaluateSimpleExpression(part.trim()));
    }

    for (const op of COMPARISON_OPERATORS) {
      if (expr.includes(op)) {
        const [left, right] = expr.split(op).map((s) => s.trim());
        return compareValues(this._parseValue(left), op, this._parseValue(right));
      }
    }

    // If no operator found, treat as boolean literal or truthy value
    return this._parseValue(expr) ? true : false;
  }

  /**
   * Parse a value from string (number, boolean, string literal)
   * @private
   * @param {string} str
   * @returns {any}
   */
  _parseValue(str) {
    const trimmed = str.trim();

    // String literals (single or double quotes)
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }

    // Boolean literals
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'undefined' || trimmed === 'null') return undefined;

    const numericValue = parseNumberLiteral(trimmed);
    if (numericValue !== null) return numericValue;

    // Return as-is for other cases
    return trimmed;
  }

  /**
   * Verify no unresolved placeholders remain
   * @private
   * @param {any} obj
   */
  _verifyResolved(obj) {
    const unresolved = this._findUnresolved(obj);
    if (unresolved.length > 0) {
      throw new Error(`Unresolved template placeholders: ${unresolved.join(', ')}`);
    }
  }

  /**
   * Find all unresolved {{param}} placeholders
   * @private
   * @param {any} obj
   * @param {string} pathPrefix
   * @returns {string[]}
   */
  _findUnresolved(obj, pathPrefix = '') {
    const unresolved = [];

    if (typeof obj === 'string') {
      const matches = obj.match(/\{\{(\w+)\}\}/g);
      if (matches) {
        unresolved.push(...matches.map((m) => `${pathPrefix}: ${m}`));
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => {
        unresolved.push(...this._findUnresolved(item, `${pathPrefix}[${i}]`));
      });
    } else if (obj && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        unresolved.push(...this._findUnresolved(value, `${pathPrefix}.${key}`));
      }
    }

    return unresolved;
  }

  /**
   * List available base templates
   * @returns {string[]}
   */
  listTemplates() {
    if (!fs.existsSync(this.baseTemplatesDir)) {
      return [];
    }
    return fs
      .readdirSync(this.baseTemplatesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''));
  }

  /**
   * Get template metadata (name, description, params)
   * @param {any} baseName
   * @returns {any}
   */
  getTemplateInfo(baseName) {
    const templatePath = resolveNamedTemplatePath(this.baseTemplatesDir, baseName, 'base template');
    if (!fs.existsSync(templatePath)) {
      return null;
    }
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    return {
      name: template.name,
      description: template.description,
      params: template.params || {},
    };
  }
}

module.exports = TemplateResolver;

// @flow

/**
 * This list determines what composes a token.
 */
import type { DotEnvObj } from './types';

const TOKENS = {
  Whitespace: [/\s/, { type: 'Whitespace', optional: true, flatten: true }],

  // A comment is the character # optionally followed by the token "CommentChars"
  Comment: ['#', { type: 'CommentChars', optional: true }],

  // A commentChars is a CommentChar optionally followed by CommentChars
  CommentChars: [{ type: 'CommentChar', flatten: true }, { type: 'CommentChars', optional: true, flatten: true }],
  CommentChar: [/[^\n]/], // anything except line terminators,
  keyedEntry: [{ type: 'Key' }, '=', { type: 'String', optional: true }],

  Key: [{ type: 'AlphaUChar', flatten: true }, { type: 'AlphaNumUChars', optional: true, flatten: true }],
  AlphaNumUChars: [{ type: 'AlphaNumUChar', flatten: true }, { type: 'AlphaNumUChars', optional: true, flatten: true }],
  AlphaUChar: [/[a-zA-Z_]/],
  AlphaNumUChar: [/[a-zA-Z0-9_]/],

  String: {
    $or: [
      'UnquotedString',
      'EmptyString',
      'QuotedString',
      'SingleQuotedString'
    ],
  },

  UnquotedString: [{ type: 'SafeChar', flatten: true }, { type: 'UnquotedStringChars', optional: true, flatten: true }],

  // any char except newline and ", " is reserved for future quoted strings.
  SafeChar: [/[^\n"']/],
  UnquotedStringChars: [/[^\\\n]/, { type: 'UnquotedStringChars', optional: true, flatten: true }],

  // TODO: This type should not exist, but QuotedString[1].optional does not work. this is a hotfix.
  EmptyString: ['""'],
  QuotedString: ['"', { type: 'QuotedStringChars', optional: true }, '"'],
  QuotedStringChars: [{ type: 'QuotedStringChar', flatten: true }, { type: 'QuotedStringChars', optional: true, flatten: true }],
  QuotedStringChar: {
    $or: [
      'UnescapedQuotedStringChar',
      'EscapedChars',
    ],
  },
  SingleQuotedString: ["'", { type: 'SingleQuotedStringChars', optional: true }, "'"],
  SingleQuotedStringChars: [{ type: 'SingleQuotedStringChar', flatten: true }, { type: 'SingleQuotedStringChars', optional: true, flatten: true }],
  SingleQuotedStringChar: {
    $or: ['UnescapedSingleQuotedStringChar']
  },
  UnescapedQuotedStringChar: [/[^\\"]/],
  UnescapedSingleQuotedStringChar: [/[^']/],
  EscapedChars: {
    replacer(val) {
      switch (val[0]) {
        case '\\\\':
          val[0] = '\\';
          break;

        case '\\n':
          val[0] = '\n';
          break;

        case '\\t':
          val[0] = '\t';
          break;

        case '\\b':
          val[0] = '\b';
          break;

        case '\\f':
          val[0] = '\f';
          break;

        case '\\r':
          val[0] = '\r';
          break;

        case '\\"':
          val[0] = '"';
          break;

        default:
      }

      return val;
    },
    token: ['\\', /[ntbfr"\\]/],
  },
};

// top level tokens
const MAIN_TOKENS = [
  TOKENS.Whitespace,
  TOKENS.Comment,
  TOKENS.keyedEntry,
];

function getTokenName(token) {

  // TODO cache
  for (const [key, val] of Object.entries(TOKENS)) {
    if (val === token) {
      return key;
    }
  }

  return null;
}

function *lex(source) {

  const state = { source, index: 0 };

  while (state.index < source.length) {

    const lastIndex = state.index;

    for (const token of MAIN_TOKENS) {
      const val = extract(token, state);
      if (val == null) {
        continue;
      }

      yield val;
    }

    if (lastIndex === state.index) {
      throw new Error(`Unexpected token ${source.charAt(lastIndex)}, at char ${lastIndex} (line: ${source.substr(state.index, 25).split('\n')[0]})`);
    }
  }
}

function extract(token, state) {

  if (token.$or) {
    for (const orToken of token.$or) {
      const val = extract(TOKENS[orToken], state);
      if (val == null) {
        continue;
      }

      return val;
    }

    return null;
  }

  const source = state.source;

  let currentIndex = state.index;
  const extractedValue = [];

  const replacer = token.replacer || null;
  if (token.token) {
    token = token.token;
  }

  for (const tokenPart of token) {
    if (typeof tokenPart === 'string') {
      const currentToken = source.substr(currentIndex, tokenPart.length);
      if (tokenPart !== currentToken) {
        return null;
      }

      extractedValue.push(currentToken);
      currentIndex += currentToken.length;

      continue;
    }

    if (tokenPart instanceof RegExp) {
      const char = source.charAt(currentIndex);

      if (!tokenPart.test(char)) {
        return null;
      }

      extractedValue.push(char);
      currentIndex += 1;

      continue;
    }

    if (typeof tokenPart === 'object' && tokenPart != null) {

      const subToken = TOKENS[tokenPart.type];

      if (subToken == null) {
        throw new Error(`Could not extract token ${tokenPart.type}, unknown token!`);
      }

      const subState = { source, index: currentIndex };
      const val = extract(subToken, subState);

      if (val == null) {
        if (!tokenPart.optional) {
          return null;
        }

        break;
      }

      if (tokenPart.flatten) {
        extractedValue.push(...val.value);
      } else {
        extractedValue.push(val);
      }

      currentIndex = subState.index;
      continue;
    }

    throw new Error(`Unsupported token part ${JSON.stringify(tokenPart)}`);
  }

  state.index = currentIndex;

  let sanitizedExtractedValue = [];
  for (let i = 0; i < extractedValue.length; i++) {
    const val = extractedValue[i];

    // concat consecutive strings
    if (typeof val === 'string' && typeof sanitizedExtractedValue[sanitizedExtractedValue.length - 1] === 'string') {
      sanitizedExtractedValue[sanitizedExtractedValue.length - 1] += val;
    } else {
      sanitizedExtractedValue.push(val);
    }
  }

  if (replacer) {
    sanitizedExtractedValue = replacer(sanitizedExtractedValue);
  }

  return { value: sanitizedExtractedValue, token: getTokenName(token) };
}

export default function parse(source: string, { extractDescriptions = false } = {}): DotEnvObj {

  const map = {};

  let lastDescription = '';
  for (const entry of lex(source)) {
    if (entry.token === 'Whitespace') {
      continue;
    }

    switch (entry.token) {

      case 'Comment':
        if (lastDescription) {
          lastDescription += '\n';
        }

        lastDescription += entry.value[1].value[0].trim();
        break;

      case 'keyedEntry': {
        const key = entry.value[0].value[0];
        const val = entry.value[2] == null ? '' : parseString(entry.value[2]);

        if (extractDescriptions) {
          map[key] = { description: lastDescription || null, value: val };
        } else {
          map[key] = val;
        }

        lastDescription = '';

        break;
      }

      case 'Whitespace':
      default:
        break;
    }
  }

  return map;
}

function parseString(val) {
  let str;
  if (val.token === 'UnquotedString') {
    str = val.value[0];
  } else {
    if (val.value.length !== 3) {
      return '';
    }

    str = val.value[1].value[0];
  }

  return str;
}

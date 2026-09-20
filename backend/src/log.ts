type Fields = Record<string, unknown>;

function emit(level: string, msg: string, fields?: Fields) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
  const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
  (level === 'error' ? console.error : console.log)(line + extra);
}

export const log = {
  info: (msg: string, f?: Fields) => emit('info', msg, f),
  warn: (msg: string, f?: Fields) => emit('warn', msg, f),
  error: (msg: string, f?: Fields) => emit('error', msg, f),
};

export function experimentModeName(protocol) {
  return protocol === 'same-question-v6' ? '同题回答' : protocol === 'reciprocal-qa-v5' ? '对称问答' : '旧讨论方式';
}

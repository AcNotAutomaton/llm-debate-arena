export function isSameQuestionProtocol(protocol) {
  return protocol === 'same-question-v6' || protocol === 'same-question-v7';
}

export function experimentModeName(protocol) {
  return protocol === 'same-question-v7' ? '同题回答（自由篇幅）' : protocol === 'same-question-v6' ? '同题回答（限定篇幅）' : protocol === 'reciprocal-qa-v5' ? '对称问答' : '旧讨论方式';
}

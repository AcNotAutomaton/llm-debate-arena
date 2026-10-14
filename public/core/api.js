export async function fetchJSON(path, options, httpError) {
  const response = await fetch(path, options);
  if (httpError && !response.ok) throw new Error(httpError);
  const data = await response.json();
  return { response, data };
}

export async function readExperiment(id) {
  const { response, data } = await fetchJSON('/api/experiments/' + encodeURIComponent(id));
  if (!response.ok) throw new Error(data.error || '无法读取实验结果');
  return data;
}

export function openDebateStream(id) {
  return new EventSource('/api/debate/' + encodeURIComponent(id) + '/stream');
}

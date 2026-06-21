import { compile } from 'vega-lite';

const spec = {
  width: 640,
  height: 260,
  data: { values: [
    { concurrentBusySessions: 1, tokensPerSecond: 100, modelId: 'm1' },
    { concurrentBusySessions: 2, tokensPerSecond: 80, modelId: 'm1' },
    { concurrentBusySessions: 1, tokensPerSecond: 90, modelId: 'm2' },
    { concurrentBusySessions: 2, tokensPerSecond: 60, modelId: 'm2' },
  ]},
  layer: [
    {
      mark: { type: 'circle', filled: true, opacity: 0.5, size: 50 },
      encoding: {
        x: { field: 'concurrentBusySessions', type: 'quantitative' },
        y: { field: 'tokensPerSecond', type: 'quantitative' },
        color: { field: 'modelId', type: 'nominal' },
      },
    },
    {
      transform: [
        { loess: 'tokensPerSecond', on: 'concurrentBusySessions', groupby: ['modelId'] },
      ],
      mark: { type: 'line', strokeWidth: 2, opacity: 0.6, point: false },
      encoding: {
        x: { field: 'concurrentBusySessions', type: 'quantitative' },
        y: { field: 'tokensPerSecond', type: 'quantitative' },
        color: { field: 'modelId', type: 'nominal' },
      },
    },
  ],
};

const out = compile(spec as any);
console.log(JSON.stringify(out.spec.data, null, 2));

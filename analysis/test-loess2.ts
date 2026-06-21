import { compile } from 'vega-lite';

const spec = {
  width: 'container',
  height: 260,
  data: { values: [
    { concurrentBusySessions: 1, tokensPerSecond: 100, modelId: 'm1' },
    { concurrentBusySessions: 2, tokensPerSecond: 80, modelId: 'm1' },
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
        { regression: 'tokensPerSecond', on: 'concurrentBusySessions', method: 'loess', groupby: ['modelId'] },
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

try {
  compile(spec as any);
  console.log('compile ok');
} catch (e) {
  console.error('compile error:', (e as Error).message);
}

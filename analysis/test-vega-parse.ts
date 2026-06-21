import { compile } from 'vega-lite';
import { parse } from 'vega';

const spec = {
  width: 640,
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

const vgSpec = compile(spec as any).spec;
try {
  parse(vgSpec);
  console.log('vega parse ok');
} catch (e) {
  console.error('vega parse error:', (e as Error).message);
}

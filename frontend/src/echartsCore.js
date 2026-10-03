// Shared, tree-shaken ECharts build. Importing from "echarts" pulls the whole
// ~1 MB library into the bundle; registering only the chart types and
// components the app actually uses (bar, line, grid, tooltip, legend,
// markLine) keeps the chunk to a fraction of that. Add registrations here if
// a plot starts using a new ECharts feature.
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

export default echarts;

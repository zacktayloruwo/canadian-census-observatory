// Shared, tree-shaken ECharts build. Importing from "echarts" pulls the whole
// ~1 MB library into the bundle; registering only the chart types and
// components the app actually uses (bar, line, scatter, grid, tooltip, legend,
// markLine, markArea, graphic) keeps the chunk to a fraction of that. Add registrations here if
// a plot starts using a new ECharts feature.
import * as echarts from "echarts/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  GraphicComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  GraphicComponent,
  CanvasRenderer,
]);

export default echarts;

// PlotErrorBoundary.jsx
//
// Keeps a chart that throws while rendering from taking the whole app down
// (React unmounts everything above an uncaught render error, leaving a blank
// page). The plot's slot shows a short note instead; a new selection
// (`resetKey`) gives the chart a fresh try.

import React from "react";
import { Text } from "@mantine/core";

export default class PlotErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[plot] render failed:", error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return (
        <Text size="xs" c="dimmed" ta="center" py="sm" role="status">
          This chart couldn&rsquo;t be drawn for the current selection.
        </Text>
      );
    }
    return this.props.children;
  }
}

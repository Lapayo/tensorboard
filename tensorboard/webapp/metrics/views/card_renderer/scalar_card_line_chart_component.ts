/* Copyright 2023 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/
import {
  ChangeDetectionStrategy,
  Component,
  ChangeDetectorRef,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';
import {DataLoadState} from '../../../types/data';
import {
  TimeSelection,
  TimeSelectionAffordance,
  TimeSelectionToggleAffordance,
} from '../../../widgets/card_fob/card_fob_types';
import {
  Formatter,
  intlNumberFormatter,
  numberFormatter,
  relativeTimeFormatter,
  siNumberFormatter,
} from '../../../widgets/line_chart_v2/lib/formatter';
import {Extent} from '../../../widgets/line_chart_v2/lib/public_types';
import {LineChartComponent} from '../../../widgets/line_chart_v2/line_chart_component';
import {RendererType, ScaleType} from '../../../widgets/line_chart_v2/types';
import {XAxisType} from '../../types';
import {TooltipTemplate} from '../../../widgets/line_chart_v2/line_chart_component';
import {
  MinMaxStep,
  ScalarCardDataSeries,
  ScalarCardPoint,
  ScalarCardSeriesMetadataMap,
} from './scalar_card_types';

const LINE_RIDER_ANIMATION_INTERVAL_MS = 80;
const LINE_RIDER_DT = LINE_RIDER_ANIMATION_INTERVAL_MS / 1000;
const LINE_RIDER_GRAVITY = 30;
const LINE_RIDER_TRACK_FRICTION = 2;
const LINE_RIDER_MIN_SPEED = 6;
const LINE_RIDER_INITIAL_SPEED = 14;
const LINE_RIDER_ROUGH_ANGLE_THRESHOLD_RAD = 1.4;
const LINE_RIDER_CRASH_SPEED_THRESHOLD = 12;
const LINE_RIDER_JUMP_SPEED_THRESHOLD = 7;
const LINE_RIDER_JUMP_DROP_DELTA_RAD = 0.5;
const LINE_RIDER_MAX_FALL_DISTANCE_FACTOR = 2;
const LINE_RIDER_MIN_VX_FOR_ANGLE = 0.1;
const LINE_RIDER_MIN_DISTANCE = 1;
const LINE_RIDER_LANDING_SPEED_FACTOR = 0.8;
const RAD_TO_DEG = 180 / Math.PI;

type LineRiderState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  segmentIndex: number;
  segmentT: number;
  airborne: boolean;
  crashed: boolean;
  minY: number;
  maxY: number;
};

@Component({
  standalone: false,
  selector: 'scalar-card-line-chart-component',
  templateUrl: 'scalar_card_line_chart_component.ng.html',
  styleUrls: ['scalar_card_line_chart_component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScalarCardLineChartComponent implements OnDestroy {
  readonly DataLoadState = DataLoadState;
  readonly RendererType = RendererType;
  readonly ScaleType = ScaleType;

  @Input() seriesMetadataMap!: ScalarCardSeriesMetadataMap;
  @Input() seriesData!: ScalarCardDataSeries[];
  @Input() ignoreOutliers!: boolean;
  @Input() disableUpdate!: boolean;
  @Input() loadState!: DataLoadState;
  @Input() smoothingEnabled!: boolean;
  @Input() xAxisType!: XAxisType;
  @Input() xScaleType!: ScaleType;
  @Input() yScaleType!: ScaleType;
  @Input() useDarkMode!: boolean;
  @Input() forceSvg!: boolean;
  @Input() stepOrLinkedTimeSelection: TimeSelection | undefined;
  @Input() minMaxStep!: MinMaxStep;
  @Input() userViewBox!: Extent | null;
  @Input() tooltipTemplate!: TooltipTemplate | null;
  @Input() allowFobRemoval!: boolean;
  @Input() disableTooltip!: boolean;

  @Output()
  onTimeSelectionChanged = new EventEmitter<{
    timeSelection: TimeSelection;
    affordance?: TimeSelectionAffordance;
  }>();
  @Output()
  onStepSelectorToggled = new EventEmitter<TimeSelectionToggleAffordance>();

  @Output() onLineChartZoom = new EventEmitter<Extent | null>();

  @ViewChild(LineChartComponent) lineChart?: LineChartComponent;

  constructor(private readonly changeDetector: ChangeDetectorRef) {}

  isViewBoxOverridden: boolean = false;
  isLineRiderEnabled = false;
  private lineRiderIntervalId: ReturnType<typeof setInterval> | null = null;
  private lineRiderStateBySeriesId = new Map<string, LineRiderState>();

  resetDomain() {
    if (this.lineChart) {
      this.lineChart.viewBoxReset();
    }
  }

  readonly relativeXFormatter = relativeTimeFormatter;
  readonly valueFormatter = numberFormatter;
  readonly stepFormatter = intlNumberFormatter;

  getCustomXFormatter(): Formatter | undefined {
    switch (this.xAxisType) {
      case XAxisType.RELATIVE:
        return relativeTimeFormatter;
      case XAxisType.STEP:
        return siNumberFormatter;
      case XAxisType.WALL_TIME:
      default:
        return undefined;
    }
  }

  onFobRemoved() {
    this.onStepSelectorToggled.emit(TimeSelectionToggleAffordance.FOB_DESELECT);
  }

  showFobController() {
    return this.xAxisType === XAxisType.STEP && this.minMaxStep;
  }

  @HostListener('window:keydown', ['$event'])
  onWindowKeyDown(event: KeyboardEvent) {
    if (event.code !== 'Space') {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }

    this.isLineRiderEnabled = !this.isLineRiderEnabled;
    this.lineRiderStateBySeriesId.clear();
    if (this.isLineRiderEnabled) {
      this.startLineRider();
    } else {
      this.stopLineRider();
    }
  }

  getLineRiderSeries() {
    const candidates = this.seriesData.filter((series) => {
      const metadata = this.seriesMetadataMap[series.id];
      return metadata?.aux !== true && metadata?.visible !== false;
    });
    // Fallback to all series so the easter egg still works when metadata is
    // unavailable or all series are auxiliary/hidden.
    return (candidates.length ? candidates : this.seriesData).filter(
      (series) => series.points.length > 1
    );
  }

  getLineRiderPosition(series: ScalarCardDataSeries) {
    const state = this.getOrCreateLineRiderState(series);
    if (!state) {
      return null;
    }
    return {
      x: state.x,
      y: state.y,
      crashed: state.crashed,
      angle:
        Math.atan2(state.vy, Math.max(LINE_RIDER_MIN_VX_FOR_ANGLE, state.vx)) *
        RAD_TO_DEG,
    };
  }

  private startLineRider() {
    this.stopLineRider();
    this.lineRiderIntervalId = setInterval(() => {
      this.stepLineRiders();
      this.changeDetector.markForCheck();
    }, LINE_RIDER_ANIMATION_INTERVAL_MS);
  }

  private stopLineRider() {
    if (this.lineRiderIntervalId !== null) {
      clearInterval(this.lineRiderIntervalId);
      this.lineRiderIntervalId = null;
    }
  }

  ngOnDestroy() {
    this.stopLineRider();
  }

  private stepLineRiders() {
    const activeSeries = this.getLineRiderSeries();
    const activeSeriesIds = new Set(activeSeries.map((series) => series.id));
    for (const staleId of this.lineRiderStateBySeriesId.keys()) {
      if (!activeSeriesIds.has(staleId)) {
        this.lineRiderStateBySeriesId.delete(staleId);
      }
    }

    for (const series of activeSeries) {
      const state = this.getOrCreateLineRiderState(series);
      if (!state) {
        continue;
      }
      this.advanceLineRiderState(state, series.points);
    }
  }

  private getOrCreateLineRiderState(series: ScalarCardDataSeries) {
    if (series.points.length < 2) {
      return null;
    }
    const existing = this.lineRiderStateBySeriesId.get(series.id);
    if (existing) {
      return existing;
    }
    const [first, second] = series.points;
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const distance = Math.hypot(dx, dy) || LINE_RIDER_MIN_DISTANCE;
    const {minY, maxY} = series.points.reduce(
      (acc, point) => ({
        minY: Math.min(acc.minY, point.y),
        maxY: Math.max(acc.maxY, point.y),
      }),
      {minY: Number.POSITIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY}
    );
    const speed = LINE_RIDER_INITIAL_SPEED;
    const state: LineRiderState = {
      x: first.x,
      y: first.y,
      vx: (dx / distance) * speed,
      vy: (dy / distance) * speed,
      speed,
      segmentIndex: 0,
      segmentT: 0,
      airborne: false,
      crashed: false,
      minY,
      maxY,
    };
    this.lineRiderStateBySeriesId.set(series.id, state);
    return state;
  }

  private advanceLineRiderState(state: LineRiderState, points: ScalarCardPoint[]) {
    if (state.crashed || points.length < 2) {
      return;
    }

    const dt = LINE_RIDER_DT;
    if (state.airborne) {
      this.advanceAirborneState(state, points, dt);
      return;
    }

    this.advanceOnTrackState(state, points, dt);
  }

  private advanceOnTrackState(
    state: LineRiderState,
    points: ScalarCardPoint[],
    dt: number
  ) {
    let remainingDistance = Math.max(state.speed, LINE_RIDER_MIN_SPEED) * dt;
    while (remainingDistance > 0 && !state.airborne && !state.crashed) {
      if (state.segmentIndex >= points.length - 1) {
        state.segmentIndex = 0;
        state.segmentT = 0;
        state.x = points[0].x;
        state.y = points[0].y;
      }
      const start = points[state.segmentIndex];
      const end = points[state.segmentIndex + 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (!length) {
        state.segmentIndex += 1;
        state.segmentT = 0;
        continue;
      }

      const tangentX = dx / length;
      const tangentY = dy / length;
      const gravityAlongTrack = -LINE_RIDER_GRAVITY * tangentY;
      state.speed = Math.max(
        LINE_RIDER_MIN_SPEED,
        state.speed + (gravityAlongTrack - LINE_RIDER_TRACK_FRICTION) * dt
      );
      state.vx = tangentX * state.speed;
      state.vy = tangentY * state.speed;

      const segmentRemaining = length * (1 - state.segmentT);
      const travel = Math.min(remainingDistance, segmentRemaining);
      state.segmentT += travel / length;
      state.x = start.x + dx * state.segmentT;
      state.y = start.y + dy * state.segmentT;
      remainingDistance -= travel;

      if (state.segmentT < 1) {
        continue;
      }

      const currentAngle = Math.atan2(dy, dx);
      const next = this.getSegment(points, state.segmentIndex + 1);
      if (next) {
        const nextAngle = Math.atan2(next.dy, next.dx);
        const angleDelta = Math.abs(nextAngle - currentAngle);
        if (
          angleDelta > LINE_RIDER_ROUGH_ANGLE_THRESHOLD_RAD &&
          state.speed > LINE_RIDER_CRASH_SPEED_THRESHOLD
        ) {
          state.crashed = true;
          state.airborne = false;
          state.x = end.x;
          state.y = end.y;
          return;
        }
        if (
          currentAngle > 0 &&
          nextAngle < currentAngle - LINE_RIDER_JUMP_DROP_DELTA_RAD &&
          state.speed > LINE_RIDER_JUMP_SPEED_THRESHOLD
        ) {
          state.airborne = true;
          state.x = end.x;
          state.y = end.y;
          state.vx = Math.cos(currentAngle) * state.speed;
          state.vy = Math.sin(currentAngle) * state.speed;
          state.segmentIndex += 1;
          state.segmentT = 0;
          return;
        }
      }

      state.segmentIndex += 1;
      state.segmentT = 0;
    }
  }

  private advanceAirborneState(
    state: LineRiderState,
    points: ScalarCardPoint[],
    dt: number
  ) {
    state.vy -= LINE_RIDER_GRAVITY * dt;
    state.x += state.vx * dt;
    state.y += state.vy * dt;

    if (
      state.y <
      state.minY - (state.maxY - state.minY) * LINE_RIDER_MAX_FALL_DISTANCE_FACTOR
    ) {
      state.crashed = true;
      state.airborne = false;
      return;
    }

    const landing = this.getTrackPointAtX(points, state.x);
    if (!landing) {
      return;
    }
    if (state.y > landing.y) {
      return;
    }

    state.airborne = false;
    state.segmentIndex = landing.segmentIndex;
    state.segmentT = landing.t;
    state.x = landing.x;
    state.y = landing.y;

    const landingAngle = Math.atan2(landing.dy, landing.dx);
    if (
      Math.abs(
        Math.atan2(state.vy, Math.max(LINE_RIDER_MIN_VX_FOR_ANGLE, state.vx)) -
          landingAngle
      ) >
        LINE_RIDER_ROUGH_ANGLE_THRESHOLD_RAD &&
      Math.abs(state.vy) > LINE_RIDER_CRASH_SPEED_THRESHOLD
    ) {
      state.crashed = true;
      return;
    }

    const speed = Math.hypot(state.vx, state.vy);
    state.speed = Math.max(
      LINE_RIDER_MIN_SPEED,
      speed * LINE_RIDER_LANDING_SPEED_FACTOR
    );
    state.vx = Math.cos(landingAngle) * state.speed;
    state.vy = Math.sin(landingAngle) * state.speed;
  }

  private getSegment(points: ScalarCardPoint[], index: number) {
    if (index < 0 || index >= points.length - 1) {
      return null;
    }
    const start = points[index];
    const end = points[index + 1];
    return {
      dx: end.x - start.x,
      dy: end.y - start.y,
    };
  }

  private getTrackPointAtX(points: ScalarCardPoint[], x: number) {
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      const minX = Math.min(start.x, end.x);
      const maxX = Math.max(start.x, end.x);
      if (x < minX || x > maxX) {
        continue;
      }
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const t = dx === 0 ? 0 : (x - start.x) / dx;
      return {
        x,
        y: start.y + dy * t,
        segmentIndex: i,
        t,
        dx,
        dy,
      };
    }
    return null;
  }

  getLineRiderStateForTest(seriesId: string) {
    return this.lineRiderStateBySeriesId.get(seriesId);
  }
}

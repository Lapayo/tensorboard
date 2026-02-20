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
  ScalarCardSeriesMetadataMap,
} from './scalar_card_types';

const LINE_RIDER_PROGRESS_INCREMENT = 0.02;
const LINE_RIDER_ANIMATION_INTERVAL_MS = 80;

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
  lineRiderProgress = 0;
  private lineRiderIntervalId: ReturnType<typeof setInterval> | null = null;

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
    this.lineRiderProgress = 0;
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
    const maxIndex = series.points.length - 1;
    const index = this.lineRiderProgress * maxIndex;
    const lower = series.points[Math.floor(index)];
    const upper = series.points[Math.ceil(index)];
    if (!lower || !upper) {
      return null;
    }
    const ratio = index % 1;
    return {
      x: lower.x + (upper.x - lower.x) * ratio,
      y: lower.y + (upper.y - lower.y) * ratio,
    };
  }

  private startLineRider() {
    this.stopLineRider();
    this.lineRiderIntervalId = setInterval(() => {
      this.lineRiderProgress =
        (this.lineRiderProgress + LINE_RIDER_PROGRESS_INCREMENT) % 1;
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
}

package com.example.fixture.web

import com.example.fixture.domain.Widget
import com.example.fixture.service.WidgetService

class WidgetController {
    WidgetService widgetService

    Widget show(Long id) {
        Widget widget = new Widget()
        return widgetService.save(widget)
    }

    String widgetName(Widget widget) {
        return widget.name
    }

    String widgetLabel(Widget widget) {
        return widget.label
    }
}

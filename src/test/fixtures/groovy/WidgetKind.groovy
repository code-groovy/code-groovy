package com.example.fixture.domain

enum WidgetKind {

    SIMPLE('s'),
    DETAILED('d', true),
    LEGACY

    String code
    Boolean verbose

    WidgetKind() {
        this('x')
    }

    WidgetKind(String code) {
        this.code = code
    }

    WidgetKind(String code, Boolean verbose) {
        this.code = code
        this.verbose = verbose
    }

    Boolean isSimple() {
        return this == WidgetKind.SIMPLE
    }
}

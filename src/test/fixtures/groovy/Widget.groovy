package com.example.fixture.domain

class Widget extends ModelEntity {
    String name

    void rename(String value) {
        name = value
    }

    void selfRename(String value) {
        this.rename(value)
    }

    String ownName() {
        return this.name
    }

    String describe() {
        String label = name
        return label
    }
}

package com.example.fixture.domain

class Invoice {
    String code
    Date dueDate

    String getCode() {
        return code?.toUpperCase()
    }

    String getReceiptCode() {
        return "R-${code}"
    }

    String getReceiptCode(String prefix) {
        return "${prefix}-${code}"
    }

    Boolean isOverdue() {
        return dueDate < new Date()
    }
}

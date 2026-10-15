package com.example.fixture.domain

class Refund {
    String code

    String getReceiptCode() {
        return "F-${code}"
    }
}

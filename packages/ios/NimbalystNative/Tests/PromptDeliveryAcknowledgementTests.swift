import XCTest
@testable import NimbalystNative

final class PromptDeliveryAcknowledgementTests: XCTestCase {
    func testMatchingPromptIdAcknowledgesTheSubmission() {
        var state = reducePromptDeliveryAcknowledgement(
            .idle,
            event: .submitted(id: "prompt-1", sessionWasExecuting: false)
        )

        state = reducePromptDeliveryAcknowledgement(
            state,
            event: .observedQueuedPromptIds(["other-prompt"])
        )
        XCTAssertEqual(state, .confirming(id: "prompt-1", sessionWasExecuting: false))

        state = reducePromptDeliveryAcknowledgement(
            state,
            event: .observedQueuedPromptIds(["prompt-1"])
        )
        XCTAssertEqual(state, .queued(id: "prompt-1", sessionWasExecuting: false))
        XCTAssertTrue(state.isAcknowledged)
        XCTAssertEqual(state.composeStatus, .queued)
    }

    func testStaleEmptyOrFalseObservationsDoNotRegressAcknowledgement() {
        var state = reducePromptDeliveryAcknowledgement(
            .idle,
            event: .submitted(id: "prompt-1", sessionWasExecuting: false)
        )
        state = reducePromptDeliveryAcknowledgement(
            state,
            event: .observedQueuedPromptIds(["prompt-1"])
        )

        state = reducePromptDeliveryAcknowledgement(state, event: .observedQueuedPromptIds([]))
        XCTAssertEqual(state, .queued(id: "prompt-1", sessionWasExecuting: false))
        state = reducePromptDeliveryAcknowledgement(state, event: .observedExecution(false))
        XCTAssertEqual(state, .queued(id: "prompt-1", sessionWasExecuting: false))
    }

    func testUnrelatedPromptIdsDoNotAcknowledgeTheCurrentSubmission() {
        let state = reducePromptDeliveryAcknowledgement(
            .confirming(id: "prompt-1", sessionWasExecuting: false),
            event: .observedQueuedPromptIds(["prompt-2"])
        )

        XCTAssertEqual(state, .confirming(id: "prompt-1", sessionWasExecuting: false))
        XCTAssertFalse(state.isAcknowledged)
    }

    func testFreshSubmissionStartsASeparateAcknowledgementWindow() {
        var state = reducePromptDeliveryAcknowledgement(
            .queued(id: "prompt-1", sessionWasExecuting: false),
            event: .submitted(id: "prompt-2", sessionWasExecuting: false)
        )
        XCTAssertEqual(state, .confirming(id: "prompt-2", sessionWasExecuting: false))
        XCTAssertFalse(state.isAcknowledged)

        state = reducePromptDeliveryAcknowledgement(
            state,
            event: .observedQueuedPromptIds(["prompt-1"])
        )
        XCTAssertEqual(state, .confirming(id: "prompt-2", sessionWasExecuting: false))

        state = reducePromptDeliveryAcknowledgement(
            state,
            event: .observedQueuedPromptIds(["prompt-2"])
        )
        XCTAssertEqual(state, .queued(id: "prompt-2", sessionWasExecuting: false))
    }

    func testExecutionObservationTransitionsAnIdleSubmissionToExecuting() {
        var state = reducePromptDeliveryAcknowledgement(
            .idle,
            event: .submitted(id: "prompt-1", sessionWasExecuting: false)
        )
        state = reducePromptDeliveryAcknowledgement(state, event: .observedExecution(true))

        XCTAssertEqual(state, .executing(id: "prompt-1"))
        XCTAssertTrue(state.isAcknowledged)
        XCTAssertEqual(state.composeStatus, .idle)

        // A prompt sent while another turn is already executing must wait for
        // its own queue acknowledgement; the existing execution flag is not
        // proof that this submission started running.
        var queuedBehindExistingTurn = reducePromptDeliveryAcknowledgement(
            .idle,
            event: .submitted(id: "prompt-2", sessionWasExecuting: true)
        )
        queuedBehindExistingTurn = reducePromptDeliveryAcknowledgement(
            queuedBehindExistingTurn,
            event: .observedExecution(true)
        )
        XCTAssertEqual(
            queuedBehindExistingTurn,
            .confirming(id: "prompt-2", sessionWasExecuting: true)
        )
    }
}
